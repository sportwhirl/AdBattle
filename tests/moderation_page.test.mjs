import assert from "node:assert/strict";
import test from "node:test";
import { startModeration } from "../moderation.mjs";

// Small DOM fixture for page orchestration; browser checks cover native rendering.
class Element {
  constructor(tag = "div", text = "") {
    this.tagName = tag;
    this.textContent = text;
    this.children = [];
    this.dataset = {};
    this.classList = { toggle() {} };
    this.value = "";
  }
  append(...children) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
      if (this.tagName === "select" && this.children.length === 1)
        this.value = child.value;
    }
  }
  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }
  replaceWith(other) {
    other.parent = this.parent;
    this.parent.children = this.parent.children.map(child => child === this ? other : child);
  }
  remove() {
    this.parent.children = this.parent.children.filter((child) => child !== this);
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(selector.split(",").includes(child.tagName) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  reportValidity() { return true; }
  get text() { return [this.textContent, ...this.children.map((child) => child.text)].join(" "); }
}
const config = {
  environment: "staging", projectRef: "test", publishableKey: "public-fixture",
  supabaseUrl: "https://nccqnrcdygujulrnwair.supabase.co",
};
async function page({ duplicate = "passed", imagesLoaded = true, previewFailure = null } = {}) {
  const ids = Object.fromEntries([
    "message", "workspace", "queue", "detail", "reviewer", "pending", "more",
    "environment", "refresh", "retry", "sign-out", "login", "login-form", "email", "password",
  ].map((id) => [id, new Element()]));
  for (const id of ["refresh", "more", "retry"]) ids[id].tagName = "button";
  ids.workspace.append(ids.queue, ids.detail, ids.refresh, ids.more, ids.pending);
  ids.pending.append(ids.retry);
  const root = { getElementById: (id) => ids[id], createElement: (tag) => new Element(tag), defaultView: { confirm: () => true } };
  const state = {
    ad: { id: "3", owner_id: "owner", image_storage_path: "owner/test.png", title: "Windmill", caption: "Test creative",
      safety_status: "held", duplicate_status: duplicate, moderation_status: "pending_scan" },
    calls: [], history: [], previewFailure, previewGate: null, queueFailure: null, queueGate: null, lostResponse: false,
  };
  const saved = new Map();
  const storage = { getItem: (k) => saved.get(k) || null, setItem: (k, v) => saved.set(k, v), removeItem: (k) => saved.delete(k) };
  const results = new Map();
  const db = {
    functions: { async invoke(name, args) {
      assert.equal(name, "moderator-ad-previews");
      assert.equal(args.body.ad_id, "3");
      assert.equal(args.body.expected_version, "version");
      if (state.previewGate) await state.previewGate;
      if (state.previewFailure) return { error: state.previewFailure };
      return { data: { ad_id: "3", version: "version", expires_in: 60,
        previews: { "3": `${config.supabaseUrl}/storage/v1/object/sign/ad-pending-images/owner/test.png?token=private-preview` } } };
    } },
    auth: {
      getUser: async () => ({ data: { user: { id: "reviewer", email: "reviewer@example.test" } } }),
      onAuthStateChange: (fn) => { state.authChange = fn; },
    },
    async rpc(name, args) {
      state.calls.push({ name, args });
      if (name === "moderator_access") return { data: { reviewer_id: "reviewer" } };
      if (name === "moderator_queue") {
        if (state.queueGate) await state.queueGate;
        if (state.queueFailure) return { error: state.queueFailure };
        return { data: { items: state.ad.safety_status === "held" || state.ad.duplicate_status.startsWith("review_") ? [{ ...state.ad }] : [], next_after_id: null } };
      }
      if (name === "moderator_ad") return { data: { ad: { ...state.ad }, version: "version", history: [...state.history], duplicate_audit: null } };
      if (name === "moderator_decide") {
        if (!results.has(args.p_request_id)) {
          state.ad[`${args.p_review_kind}_status`] = args.p_decision === "clear" ? "passed" : "failed";
          state.ad.moderation_status = state.ad.safety_status === "passed" && state.ad.duplicate_status === "passed" ? "approved" : "pending_scan";
          results.set(args.p_request_id, { ad_id: "3", review_kind: args.p_review_kind, decision: args.p_decision, ...state.ad });
          state.history.push({ review_kind: args.p_review_kind, decision: args.p_decision, reason: args.p_reason });
        }
        if (state.lostResponse) { state.lostResponse = false; throw Error("Network interrupted"); }
        return { data: results.get(args.p_request_id) };
      }
      throw Error(`Unexpected RPC: ${name}`);
    },
  };
  await startModeration(root, { createClient: () => db }, config, storage);
  await ids.queue.querySelector("button").onclick();
  const loadImages = () => ids.detail.querySelectorAll("img").forEach(image => image.onload());
  if (imagesLoaded) loadImages();
  return {
    ids, state, saved, loadImages,
    async decide(decision = "clear") {
      const form = ids.detail.querySelector("form");
      form.querySelectorAll("select").find((e) => e.name === "decision").value = decision;
      form.querySelector("textarea").value = "Reviewed staging creative and screening findings.";
      await form.onsubmit({ preventDefault() {} });
    },
  };
}

test("confirmed clearance closes the review immediately, before the queue reload finishes", async () => {
  const p = await page();
  let release;
  p.state.queueGate = new Promise((resolve) => { release = resolve; });
  const decision = p.decide();
  await new Promise(setImmediate);
  assert.equal(p.ids.queue.querySelectorAll("button").length, 0);
  assert.match(p.ids.detail.text, /Review complete for ad #3/);
  assert.equal(p.ids.detail.querySelector("form"), null);
  assert.match(p.ids.message.textContent, /Decision recorded/);
  release();
  await decision;
  assert.match(p.ids.queue.text, /No ads need human review/);
  assert.equal(p.saved.size, 0);
});

test("a confirmed decision stays complete when the follow-up queue read fails", async () => {
  const p = await page();
  p.state.queueFailure = { message: "Network unavailable" };
  await p.decide();
  assert.equal(p.ids.queue.querySelectorAll("button").length, 0);
  assert.match(p.ids.detail.text, /Review complete/);
  assert.match(p.ids.message.textContent, /Decision recorded.*Refresh queue/);
  assert.equal(p.saved.size, 0);
  assert.equal(p.ids.refresh.disabled, false);
});

test("clearing one of two checks keeps the ad queued and shows only the remaining check", async () => {
  const p = await page({ duplicate: "review_similar" });
  await p.decide();
  assert.equal(p.ids.queue.querySelectorAll("button").length, 1);
  assert.match(p.ids.detail.text, /Safety: passed/);
  const kinds = p.ids.detail.querySelectorAll("select").find((e) => e.name === "review_kind");
  assert.deepEqual(kinds.children.map((e) => e.value), ["duplicate"]);
});

test("Refresh queue closes a selected review that another request already resolved", async () => {
  const p = await page();
  p.state.ad.safety_status = "passed";
  p.state.ad.moderation_status = "approved";
  await p.ids.refresh.onclick();
  assert.equal(p.ids.queue.querySelectorAll("button").length, 0);
  assert.match(p.ids.detail.text, /Review complete/);
  assert.equal(p.ids.detail.querySelector("form"), null);
});

test("lost decision response retains the review and retry UUID, then closes on confirmation", async () => {
  const p = await page();
  p.state.lostResponse = true;
  await p.decide();
  assert.equal(p.saved.size, 1);
  assert.equal(p.ids.queue.querySelectorAll("button").length, 1);
  assert.equal(p.ids.pending.hidden, false);
  await p.ids.retry.onclick();
  const calls = p.state.calls.filter((c) => c.name === "moderator_decide");
  assert.deepEqual(calls[0].args, calls[1].args);
  assert.equal(p.state.history.length, 1);
  assert.equal(p.saved.size, 0);
  assert.match(p.ids.detail.text, /Review complete/);
});

test("access denial during the follow-up read clears private data", async () => {
  const p = await page();
  p.state.queueFailure = { message: "MODERATOR_ACCESS_REQUIRED", code: "42501" };
  await p.decide();
  assert.equal(p.ids.workspace.hidden, true);
  assert.equal(p.ids.detail.children.length, 0);
  assert.equal(p.ids.queue.children.length, 0);
  assert.match(p.ids.message.textContent, /Moderator access is unavailable/);
});


test("private previews must load before a decision is sent", async () => {
  const p = await page({ imagesLoaded: false });
  assert.equal(p.ids.detail.querySelector("button").disabled, true);
  await p.decide();
  assert.equal(p.state.calls.filter(c => c.name === "moderator_decide").length, 0);
  p.loadImages();
  assert.equal(p.ids.detail.querySelector("button").disabled, false);
  await p.decide();
  assert.equal(p.state.history.length, 1);
});

test("missing preview keeps controls disabled and refresh can recover", async () => {
  const p = await page({ previewFailure: { message: "unavailable" } });
  assert.equal(p.ids.detail.querySelectorAll("img").length, 0);
  assert.equal(p.ids.detail.querySelector("button").disabled, true);
  await p.decide();
  assert.equal(p.state.history.length, 0);
  p.state.previewFailure = null;
  await p.ids.refresh.onclick();
  p.loadImages();
  assert.equal(p.ids.detail.querySelector("button").disabled, false);
});

test("preview authorization failure clears the entire private workspace", async () => {
  const p = await page({ previewFailure: { context: { status: 403 } } });
  assert.equal(p.ids.workspace.hidden, true);
  assert.equal(p.ids.detail.children.length, 0);
  assert.equal(p.ids.queue.children.length, 0);
});

test("a stale image load cannot unlock another review or a revoked session", async () => {
  const p = await page({ imagesLoaded: false });
  const stale = p.ids.detail.querySelector("img");
  await p.ids.refresh.onclick();
  stale.onload();
  assert.equal(p.ids.detail.querySelector("button").disabled, true);
  p.state.queueFailure = { code: "42501", message: "MODERATOR_ACCESS_REQUIRED" };
  await p.ids.refresh.onclick();
  stale.onload();
  assert.equal(p.ids.workspace.hidden, true);
  assert.equal(p.ids.detail.children.length, 0);
});


test("an image load failure relocks the decision form", async () => {
  const p = await page();
  assert.equal(p.ids.detail.querySelector("button").disabled, false);
  p.ids.detail.querySelector("img").onerror();
  assert.equal(p.ids.detail.querySelector("button").disabled, true);
  assert.match(p.ids.detail.text, /Image unavailable/);
  await p.decide();
  assert.equal(p.state.history.length, 0);
});
