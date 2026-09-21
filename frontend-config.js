(function (root) {
    "use strict";

    const PRODUCTION = Object.freeze({
        environment: "production",
        projectRef: "bmsrdzqprxvldltaislp",
        supabaseUrl: "https://bmsrdzqprxvldltaislp.supabase.co",
        publishableKey: "sb_publishable__DHmkTcq5Utga1QQHn1smg_09D9Nqrd",
        features: Object.freeze({
            likes: true,
            adImages: true,
            creatorOnboarding: true
        })
    });
    const STAGING_REF = "nccqnrcdygujulrnwair";
    const STAGING_URL = `https://${STAGING_REF}.supabase.co`;
    const STAGING_ORIGIN = "http://localhost:8000";

    function isPublicKey(value) {
        if (typeof value !== "string" || !value) return false;
        if (value.startsWith("sb_publishable_")) return true;
        try {
            const parts = value.split(".");
            if (parts.length !== 3) return false;
            const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
            const claims = JSON.parse(root.atob(payload + "=".repeat((4 - payload.length % 4) % 4)));
            return claims.role === "anon" && claims.ref === STAGING_REF;
        } catch (_error) {
            return false;
        }
    }

    function resolve(location, supplied) {
        const local = location.protocol === "file:" ||
            location.hostname === "localhost" || location.hostname === "127.0.0.1";
        if (!local) return PRODUCTION;
        if (!supplied || supplied.environment !== "staging" ||
            supplied.projectRef !== STAGING_REF || supplied.supabaseUrl !== STAGING_URL ||
            supplied.frontendOrigin !== STAGING_ORIGIN || !isPublicKey(supplied.publishableKey)) {
            throw new Error("Local staging configuration is missing or invalid; refusing to connect to Supabase.");
        }
        return Object.freeze({
            environment: "staging",
            projectRef: STAGING_REF,
            supabaseUrl: STAGING_URL,
            publishableKey: supplied.publishableKey,
            features: Object.freeze({ likes: false, adImages: false, creatorOnboarding: false })
        });
    }

    root.AdBattleConfig = Object.freeze({ resolve, PRODUCTION, STAGING_REF, STAGING_ORIGIN });
})(globalThis);
