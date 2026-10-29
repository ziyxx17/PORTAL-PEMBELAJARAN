const SUPABASE_URL = "https://wwqyrpsgfrgzpkazsxrl.supabase.co";

const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_J_X30jbkeQFA9ZZCBQbKNw_Kk9teyna";

/* =====================================================
   SINGLE SESSION - 1 akun hanya boleh aktif di 1 tab/perangkat
   Taruh sejajar dengan config.js, lalu load SETELAH library Supabase.
===================================================== */
window.PORTAL_VERSION = "v3";

window.SingleSession = (function () {
    // Saklar darurat: ubah ke false untuk MEMATIKAN pembatasan 1 sesi sementara
    // (login dan halaman member berjalan seperti biasa tanpa cek database).
    const ENFORCE = true;

    const KEY = "portal_session_token";
    const LOGIN_PAGE = "index.html";
    let timer = null;
    let ended = false;

    function getToken() {
        return sessionStorage.getItem(KEY);
    }

    // crypto.randomUUID hanya tersedia di HTTPS/localhost, jadi sediakan cadangan
    function makeUUID() {
        if (window.crypto && typeof window.crypto.randomUUID === "function") {
            return window.crypto.randomUUID();
        }
        const b = new Uint8Array(16);
        window.crypto.getRandomValues(b);
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        const h = Array.from(b, function (x) { return x.toString(16).padStart(2, "0"); }).join("");
        return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
    }

    // Dipanggil di login.js SETELAH signIn berhasil.
    // Mengembalikan kode dari database:
    //   "ok" = sesi berhasil diklaim
    //   "active" = akun masih aktif di tab/perangkat lain
    //   "locked" = akun dikunci admin
    //   "not_member" / "no_profile" = bukan member / profil tidak ada
    async function claim(client) {
        if (!ENFORCE) { sessionStorage.setItem(KEY, "off"); return "ok"; }
        const token = makeUUID();
        const { data, error } = await client.rpc("claim_login", { p_token: token, p_device: (navigator.userAgent || "").slice(0, 300) });
        if (error) throw error;
        if (data === "ok") sessionStorage.setItem(KEY, token);
        return data;
    }

    // Dipanggil oleh tombol Keluar / Logout.
    async function release(client) {
        if (!ENFORCE) { sessionStorage.removeItem(KEY); return; }
        const token = getToken();
        sessionStorage.removeItem(KEY);
        stop();
        if (!token) return;
        try {
            await client.rpc("release_login", { p_token: token });
        } catch (e) {
            console.error("release_login gagal:", e);
        }
    }

    // true = masih sah, false = sudah di-reset admin / tidak sah
    async function isValid(client) {
        if (!ENFORCE) return !!getToken();
        const token = getToken();
        if (!token) return false;
        const { data, error } = await client.rpc("check_login", { p_token: token });
        if (error) return true; // gangguan jaringan: jangan tendang member
        return data === true;
    }

    function stop() {
        ended = true;
        if (timer) { clearInterval(timer); timer = null; }
    }

    // why: "no_token" = tab ini tidak punya token klaim (login lama / tab baru)
    //      "revoked"  = token tidak cocok lagi (di-reset admin / dipakai di tempat lain)
    async function kick(client, why) {
        if (ended) return;
        stop();
        console.warn("[SingleSession] dikeluarkan, alasan:", why);
        sessionStorage.removeItem(KEY);
        try { await client.auth.signOut({ scope: "local" }); } catch (e) {}
        const from = encodeURIComponent((window.location.pathname.split("/").pop() || "").slice(0, 40));
        window.location.href = LOGIN_PAGE + "?reason=session&why=" + (why || "revoked") + "&from=" + from;
    }

    // Pasang di setiap halaman member. Pindah tab TIDAK mengunci akun;
    // yang dicek hanya apakah token tab ini masih sah di database.
    async function guard(client, intervalMs) {
        if (!ENFORCE) return true;
        if (!getToken()) { await kick(client, "no_token"); return false; }
        if (!(await isValid(client))) { await kick(client, "revoked"); return false; }

        timer = setInterval(async function () {
            if (!(await isValid(client))) await kick(client, "revoked");
        }, intervalMs || 10000);

        document.addEventListener("visibilitychange", async function () {
            if (document.visibilityState === "visible" && !ended) {
                if (!(await isValid(client))) await kick(client, "revoked");
            }
        });
        return true;
    }

    // Untuk halaman yang dipakai member DAN admin (subjects, materials):
    // tab member (punya token) pakai sessionStorage, admin tetap pakai localStorage.
    function createClient(url, key) {
        // Semua peran memakai sesi per-tab (sessionStorage) supaya antar tab tidak saling mengganggu
        return window.supabase.createClient(url, key, { auth: { storage: window.sessionStorage } });
    }

    return { claim, release, isValid, guard, getToken, createClient };
})();


/* IZIN PERAN: admin selalu boleh; moderator mengikuti pengaturan admin (tabel role_permissions) */
window.Perm = (function () {
    const cache = {};
    async function allow(client, role, key) {
        role = String(role || "").toLowerCase();
        if (role === "admin") return true;
        if (role !== "moderator") return false;
        if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
        const { data, error } = await client.rpc("has_permission", { p_key: key });
        cache[key] = !error && data === true;
        return cache[key];
    }
    return { allow };
})();


/* SESI STAFF (Admin & Moderator): kehadiran (presence), 1 sesi untuk Moderator, keluar resmi.
   Berjalan otomatis di halaman admin tanpa mengubah kode halaman. */
window.StaffSession = (function () {
    const PAGES = ["admin", "member-management", "kelola-jadwal", "announcements-admin", "statistics",
                   "user-status", "admin-settings", "riwayat-login", "izin-peran", "subjects", "materials"];
    const ref = (function () { try { return new URL(SUPABASE_URL).hostname.split(".")[0]; } catch (e) { return ""; } })();
    const STORE_KEY = "sb-" + ref + "-auth-token";
    let ended = false;

    function pageName() { return (window.location.pathname.split("/").pop() || "").replace(".html", ""); }
    function readSession() {
        try {
            const j = JSON.parse(sessionStorage.getItem(STORE_KEY) || "null");
            return j && j.access_token && j.user ? j : null;
        } catch (e) { return null; }
    }
    function api(path, session, opts) {
        opts = opts || {};
        return fetch(SUPABASE_URL + "/rest/v1/" + path, {
            method: opts.method || "GET",
            headers: Object.assign({
                apikey: SUPABASE_PUBLISHABLE_KEY,
                Authorization: "Bearer " + session.access_token,
                "Content-Type": "application/json"
            }, opts.headers || {}),
            body: opts.body ? JSON.stringify(opts.body) : undefined
        });
    }
    async function getRole(session) {
        try {
            const r = await api("profiles?select=role,status&id=eq." + session.user.id, session);
            const rows = await r.json();
            return Array.isArray(rows) && rows[0] ? String(rows[0].role || "").toLowerCase() : "";
        } catch (e) { return ""; }
    }
    async function beat(session) {
        try {
            await api("user_presence?on_conflict=user_id", session, {
                method: "POST",
                headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
                body: { user_id: session.user.id, is_online: true, last_seen: new Date().toISOString() }
            });
        } catch (e) {}
    }
    async function tokenValid(session) {
        try {
            const r = await api("rpc/check_login", session, { method: "POST", body: { p_token: SingleSession.getToken() } });
            if (!r.ok) return true;              // gangguan: jangan tendang
            return (await r.json()) === true;
        } catch (e) { return true; }
    }
    function kick(why) {
        if (ended) return;
        ended = true;
        sessionStorage.removeItem(STORE_KEY);
        sessionStorage.removeItem("portal_session_token");
        window.location.href = "index.html?reason=session&why=" + why + "&from=" + encodeURIComponent(pageName());
    }

    async function start() {
        if (PAGES.indexOf(pageName()) < 0) return;
        const first = readSession();
        if (!first) return;
        const role = await getRole(first);
        if (role !== "admin" && role !== "moderator") return;   // member ditangani halamannya sendiri

        const tick = function () {
            const s = readSession();
            if (s && !ended && document.visibilityState === "visible") beat(s);
        };
        tick();
        setInterval(tick, 30000);

        if (role === "moderator") {
            const guardTick = async function () {
                if (ended) return;
                const s = readSession();
                if (!s) return;
                if (!SingleSession.getToken()) { kick("no_token"); return; }
                if (!(await tokenValid(s))) kick("revoked");
            };
            guardTick();
            setInterval(guardTick, 10000);
            document.addEventListener("visibilitychange", function () {
                if (document.visibilityState === "visible") guardTick();
            });
        }
    }

    // Dipanggil tombol Keluar di dashboard: lepas klaim (Moderator) + hapus kehadiran
    async function leave(client) {
        ended = true;
        try {
            const { data } = await client.auth.getSession();
            if (data && data.session) {
                await client.from("user_presence").delete().eq("user_id", data.session.user.id);
            }
        } catch (e) {}
        try { await SingleSession.release(client); } catch (e) {}
    }

    window.addEventListener("load", function () { setTimeout(start, 800); });
    return { leave };
})();
