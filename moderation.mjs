// This page holds no privileged keys. The database authorizes every RPC.
const DEFINITIVE_ERRORS = new Set([
  "INVALID_REVIEW",
  "REVIEW_REQUEST_CONFLICT",
  "AD_NOT_FOUND",
  "REVIEW_ALREADY_RESOLVED",
  "REVIEW_CHANGED_REFRESH_REQUIRED",
  "REMOVED_AD_CANNOT_BE_REVIEWED",
  "SAFETY_REVIEW_NOT_HELD",
  "DUPLICATE_REVIEW_ALREADY_RESOLVED",
  "DUPLICATE_REVIEW_NOT_HELD",
  "DUPLICATE_REVIEW_MATCH_REQUIRED",
]);
export function safeImageUrl(ad, config) {
  const path = ad?.image_storage_path;
  if (
    typeof path !== "string" ||
    !ad.owner_id ||
    !path.startsWith(`${ad.owner_id}/`) ||
    path.includes("\\")
  )
    return null;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return `${config.supabaseUrl}/storage/v1/object/public/ad-images/${parts.map(encodeURIComponent).join("/")}`;
}
export function reviewKinds(ad) {
  if (!ad || ad.moderation_status === "removed") return [];
  return [
    ...(ad.safety_status === "held" ? ["safety"] : []),
    ...(["review_identical", "review_similar"].includes(ad.duplicate_status)
      ? ["duplicate"]
      : []),
  ];
}
export function createDecisionClient(
  db,
  storage,
  project,
  user,
  uuid = () => crypto.randomUUID(),
) {
  const key = `adbattle:moderator-decision:${project}:${user}`;
  function pending() {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (
      !value ||
      typeof value.p_request_id !== "string" ||
      typeof value.p_ad_id !== "string" ||
      !["safety", "duplicate"].includes(value.p_review_kind) ||
      !["clear", "reject"].includes(value.p_decision) ||
      typeof value.p_reason !== "string" ||
      typeof value.p_expected_version !== "string"
    ) {
      throw new Error(
        "Saved decision could not be read. Ask an administrator to reconcile it.",
      );
    }
    return value;
  }
  async function retry() {
    const request = pending();
    if (!request) throw new Error("No saved decision to retry.");
    const { data, error } = await db.rpc("moderator_decide", request);
    if (error) {
      if (DEFINITIVE_ERRORS.has(error.message)) storage.removeItem(key);
      throw error;
    }
    if (
      !data ||
      data.ad_id !== request.p_ad_id ||
      data.review_kind !== request.p_review_kind ||
      data.decision !== request.p_decision
    ) {
      throw new Error(
        "Decision response is unconfirmed. Retry the saved request.",
      );
    }
    storage.removeItem(key);
    return data;
  }
  async function submit(ad, kind, decision, reason) {
    if (pending()) throw new Error("Resolve the saved decision first.");
    const request = {
      p_request_id: uuid(),
      p_ad_id: String(ad.ad.id),
      p_review_kind: kind,
      p_decision: decision,
      p_reason: reason.trim(),
      p_expected_version: ad.version,
    };
    // Failure to persist stops the request. Lost responses reuse this exact UUID.
    storage.setItem(key, JSON.stringify(request));
    if (storage.getItem(key) !== JSON.stringify(request))
      throw new Error("Could not save the decision safely.");
    return retry();
  }
  return { pending, retry, submit };
}

export async function startModeration(root, sdk, config, storage) {
  const $ = (id) => root.getElementById(id);
  const db = sdk.createClient(config.supabaseUrl, config.publishableKey);
  let epoch = 0,
    user = null,
    client = null,
    selected = null,
    cursor = null,
    busy = false;
  const node = (tag, text, cls) => {
    const e = root.createElement(tag);
    if (text != null) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  };
  function message(text, error = false) {
    $("message").textContent = text;
    $("message").className = error ? "error" : "";
  }
  function reviewComplete(id) {
    selected = null;
    $("detail").replaceChildren(
      node("h2", `Review complete for ad #${id}`),
      node("p", "No human-review checks remain. Select another ad from the queue."),
    );
    for (const button of $("queue").querySelectorAll("button")) {
      if (button.dataset.id === id) button.remove();
      else button.classList.toggle("selected", false);
    }
    if (!$("queue").children.length)
      $("queue").append(node("p", "No ads need human review.", "muted"));
  }
  function resetView() {
    $("workspace").hidden = true;
    $("queue").replaceChildren();
    $("detail").replaceChildren();
    $("reviewer").textContent = "";
    $("pending").hidden = true;
    selected = null;
    cursor = null;
  }
  function pendingState() {
    const saved = client?.pending();
    $("pending").hidden = !saved;
    return saved;
  }
  function controls() {
    let saved;
    try {
      saved = pendingState();
    } catch (e) {
      message(e.message, true);
      saved = true;
      $("pending").hidden = true;
    }
    for (const control of $("workspace").querySelectorAll(
      "button,input,textarea,select",
    ))
      control.disabled = busy;
    for (const control of $("detail").querySelectorAll(
      "button,input,textarea,select",
    ))
      control.disabled = busy || !!saved;
  }
  async function rpc(name, args) {
    const { data, error } = await db.rpc(name, args);
    if (error) throw error;
    return data;
  }
  function reportError(error) {
    const text = error?.message || "Request failed.";
    if (text === "MODERATOR_ACCESS_REQUIRED" || error?.code === "42501") {
      resetView();
      message(
        "Moderator access is unavailable. Sign in with an authorized account, or ask your administrator.",
        true,
      );
    } else if (DEFINITIVE_ERRORS.has(text))
      message(
        "This decision was not applied. Refresh the ad and review its current state.",
        true,
      );
    else
      message(
        "The request could not be confirmed. Refresh to reconnect, or retry any saved decision. " +
          text,
        true,
      );
  }
  async function queue(append = false) {
    const ticket = epoch;
    const data = await rpc("moderator_queue", {
      p_after_id: append ? cursor : "0",
    });
    if (ticket !== epoch) return;
    if (!append) $("queue").replaceChildren();
    for (const item of data.items) {
      const b = node("button", null, "queue-item");
      b.dataset.id = item.id;
      b.append(
        node("strong", `#${item.id} · ${item.title}`),
        node(
          "span",
          `${item.safety_status === "held" ? "Safety hold" : ""}${item.safety_status === "held" && item.duplicate_status.startsWith("review_") ? " · " : ""}${item.duplicate_status.startsWith("review_") ? "Duplicate review" : ""}`,
        ),
      );
      b.onclick = () => action(() => loadAd(item.id));
      $("queue").append(b);
    }
    if (!$("queue").children.length)
      $("queue").append(node("p", "No ads need human review.", "muted"));
    cursor = data.next_after_id;
    $("more").hidden = !cursor;
    for (const b of $("queue").querySelectorAll("button"))
      b.classList.toggle("selected", b.dataset.id === selected);
  }
  function creative(ad, heading) {
    const box = node("div", null, "creative");
    box.append(node("h3", heading));
    const url = safeImageUrl(ad, config);
    if (url) {
      const img = node("img");
      img.src = url;
      img.alt = ad.title || "Ad creative";
      img.referrerPolicy = "no-referrer";
      img.onerror = () =>
        img.replaceWith(
          node(
            "p",
            "Image unavailable. Do not clear a review until you can inspect the creative.",
            "placeholder",
          ),
        );
      box.append(img);
    } else
      box.append(
        node(
          "p",
          "No trusted stored image is available for this ad.",
          "placeholder",
        ),
      );
    box.append(
      node("p", `#${ad.id} · ${ad.title}`),
      node("p", ad.caption || "No caption"),
      node(
        "p",
        `Owner ${ad.owner_id} · ${ad.created_at || "Date unavailable"}`,
        "muted",
      ),
    );
    return box;
  }
  function renderDetail(detail) {
    const ad = detail.ad;
    const pane = $("detail");
    pane.replaceChildren();
    pane.append(node("h2", `Review ad #${ad.id}`));
    const badges = node("div", null, "badges");
    for (const [name, value] of [
      ["Safety", ad.safety_status],
      ["Duplicates", ad.duplicate_status],
      ["Publication", ad.moderation_status],
    ])
      badges.append(node("span", `${name}: ${value}`, "badge"));
    pane.append(badges);
    const creatives = node("div", null, "creative-grid");
    creatives.append(creative(ad, "Submitted creative"));
    if (ad.matched_ad)
      creatives.append(creative(ad.matched_ad, "Matched creative"));
    pane.append(creatives);
    pane.append(
      node("h3", "Why it needs review"),
      node(
        "p",
        ad.reason || "Review the duplicate match and scanner details below.",
      ),
    );
    if (ad.duplicate_status === "review_similar")
      pane.append(
        node(
          "p",
          "Visual similarity is a review signal, not proof of ownership.",
          "muted",
        ),
      );
    const findings = node("details");
    findings.append(
      node("summary", "Scanner findings"),
      node(
        "pre",
        JSON.stringify(
          {
            risk_score: ad.risk_score,
            scan_version: ad.scan_version,
            details: ad.details,
            last_error: ad.last_error,
          },
          null,
          2,
        ),
      ),
    );
    pane.append(findings);
    const kinds = reviewKinds(ad);
    if (kinds.length) {
      const form = node("form", null, "review-form");
      const row = node("div", null, "form-row");
      const kindLabel = node("label", "Screening check");
      const kind = node("select");
      kind.name = "review_kind";
      for (const k of kinds) {
        const o = node(
          "option",
          k === "safety" ? "Safety review" : "Duplicate review",
        );
        o.value = k;
        kind.append(o);
      }
      kindLabel.append(kind);
      const decisionLabel = node("label", "Decision");
      const decision = node("select");
      decision.name = "decision";
      for (const [value, label] of [
        ["", "Choose a decision"],
        ["clear", "Clear this check"],
        ["reject", "Reject this check"],
      ]) {
        const o = node("option", label);
        o.value = value;
        decision.append(o);
      }
      decision.required = true;
      decisionLabel.append(decision);
      row.append(kindLabel, decisionLabel);
      const reasonLabel = node("label", "Review reason (10–2,000 characters)");
      const reason = node("textarea");
      reason.name = "reason";
      reason.minLength = 10;
      reason.maxLength = 2000;
      reason.required = true;
      reasonLabel.append(reason);
      const submit = node("button", "Record decision", "primary");
      submit.type = "submit";
      form.append(
        node("h3", "Record your review"),
        node(
          "p",
          "Clearing one check only publishes the ad if both checks pass.",
          "muted",
        ),
        row,
        reasonLabel,
        submit,
      );
      form.onsubmit = (e) => {
        e.preventDefault();
        if (!form.reportValidity()) return;
        if (
          !root.defaultView.confirm(
            `Record ${decision.value === "clear" ? "CLEAR" : "REJECT"} for the ${kind.value} check on ad #${ad.id}?`,
          )
        )
          return;
        return action(async (ticket) => {
          const result = await client.submit(
            detail,
            kind.value,
            decision.value,
            reason.value,
          );
          if (ticket === epoch) await decisionDone(result, ticket);
        });
      };
      pane.append(form);
    } else
      pane.append(
        node(
          "p",
          "There are no open human-review checks for this ad.",
          "notice",
        ),
      );
    pane.append(node("h3", "Decision history"));
    if (!detail.history.length && !detail.duplicate_audit)
      pane.append(node("p", "No recorded human decisions yet.", "muted"));
    for (const h of detail.history) {
      const entry = node("div", null, "history-entry");
      entry.append(
        node("strong", `${h.review_kind}: ${h.decision}`),
        node("p", h.reason),
        node("p", `${h.reviewer_id} · ${h.created_at}`, "muted"),
      );
      pane.append(entry);
    }
    if (detail.duplicate_audit) {
      const audit = node("details");
      audit.append(
        node("summary", "Original duplicate decision audit"),
        node("pre", JSON.stringify(detail.duplicate_audit, null, 2)),
      );
      pane.append(audit);
    }
  }
  async function loadAd(id) {
    const ticket = epoch;
    const detail = await rpc("moderator_ad", { p_ad_id: id });
    if (ticket !== epoch) return;
    if (!reviewKinds(detail.ad).length) {
      reviewComplete(id);
      message(`Ad #${id} has no remaining human-review checks.`);
      return;
    }
    selected = id;
    renderDetail(detail);
    message(`Reviewing ad #${id}.`);
    for (const b of $("queue").querySelectorAll("button"))
      b.classList.toggle("selected", b.dataset.id === id);
  }
  async function decisionDone(result, ticket) {
    const summary = `Decision recorded. Ad #${result.ad_id} publication status: ${result.moderation_status}.`;
    const complete = !reviewKinds(result).length;
    // A confirmed decision is authoritative even if the follow-up read fails.
    // Close the completed review before waiting for the queue to reconnect.
    if (complete) reviewComplete(result.ad_id);
    message(summary);
    try {
      await queue();
      if (ticket !== epoch) return;
      if (!complete) await loadAd(result.ad_id);
      if (ticket === epoch) message(summary);
    } catch (error) {
      if (ticket !== epoch) return;
      if (error?.message === "MODERATOR_ACCESS_REQUIRED" || error?.code === "42501")
        reportError(error);
      else
        message(`${summary} The latest queue could not be loaded. Use Refresh queue to reconnect.`, true);
    }
  }
  async function action(fn) {
    if (busy) return;
    const ticket = epoch;
    busy = true;
    controls();
    try {
      await fn(ticket);
    } catch (e) {
      if (ticket === epoch) reportError(e);
    } finally {
      if (ticket === epoch) {
        busy = false;
        controls();
      }
    }
  }
  async function authenticate() {
    const ticket = ++epoch;
    user = null;
    client = null;
    busy = false;
    resetView();
    $("login").hidden = true;
    try {
      const { data, error } = await db.auth.getUser();
      if (ticket !== epoch) return;
      if (error || !data.user) {
        $("login").hidden = false;
        $("sign-out").hidden = true;
        message("Sign in to review held ads.");
        return;
      }
      user = data.user;
      $("sign-out").hidden = false;
      const access = await rpc("moderator_access");
      if (ticket !== epoch) return;
      if (access.reviewer_id !== user.id)
        throw new Error("MODERATOR_ACCESS_REQUIRED");
      client = createDecisionClient(db, storage, config.projectRef, user.id);
      $("reviewer").textContent = `Signed in as ${user.email || user.id}`;
      $("workspace").hidden = false;
      await queue();
      if (ticket !== epoch) return;
      message("Select an ad to begin.");
      controls();
    } catch (e) {
      if (ticket === epoch) reportError(e);
    }
  }
  $("environment").textContent =
    config.environment === "staging"
      ? "ADBATTLE TEST · LOCAL STAGING"
      : "PRODUCTION";
  $("refresh").onclick = () =>
    action(async (ticket) => {
      await queue();
      if (ticket !== epoch) return;
      if (selected) await loadAd(selected);
      if (ticket === epoch) message("Queue refreshed.");
    });
  $("more").onclick = () => action(() => queue(true));
  $("retry").onclick = () =>
    action(async (ticket) => {
      const result = await client.retry();
      if (ticket === epoch) await decisionDone(result, ticket);
    });
  $("sign-out").onclick = async () => {
    ++epoch;
    resetView();
    client = null;
    user = null;
    await db.auth.signOut();
    await authenticate();
  };
  $("login-form").onsubmit = async (e) => {
    e.preventDefault();
    const button = $("login-form").querySelector("button");
    button.disabled = true;
    const credentials = {
      email: $("email").value.trim(),
      password: $("password").value,
    };
    $("password").value = "";
    try {
      const { error } = await db.auth.signInWithPassword(credentials);
      if (error) throw error;
      await authenticate();
    } catch (_e) {
      message("Sign-in failed. Check your email and password.", true);
    } finally {
      button.disabled = false;
    }
  };
  // Schedule outside the auth callback to avoid awaiting client calls inside its lock.
  db.auth.onAuthStateChange((event, session) => {
    if (
      ["SIGNED_OUT", "USER_UPDATED"].includes(event) ||
      (event === "SIGNED_IN" && session?.user?.id !== user?.id)
    ) {
      ++epoch;
      resetView();
      client = null;
      user = null;
      setTimeout(authenticate, 0);
    }
  });
  await authenticate();
}
if (typeof document !== "undefined") {
  try {
    const config = globalThis.AdBattleConfig.resolve(
      location,
      globalThis.ADBATTLE_LOCAL_CONFIG,
    );
    await startModeration(
      document,
      globalThis.supabase,
      config,
      globalThis.sessionStorage,
    );
  } catch (_error) {
    document.getElementById("message").textContent =
      "Moderation could not start. Check the approved origin, project configuration, and network connection.";
  }
}
