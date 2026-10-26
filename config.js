const SUPABASE_URL = "https://wwqyrpsgfrgzpkazsxrl.supabase.co";

const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_J_X30jbkeQFA9ZZCBQbKNw_Kk9teyna";

/* =====================================================
   SINGLE SESSION - 1 akun hanya boleh aktif di 1 tab/perangkat
   Taruh sejajar dengan config.js, lalu load SETELAH library Supabase.
===================================================== */
window.SingleSession = (function () {
    // Saklar darurat: ubah ke false untuk MEMATIKAN pembatasan 1 sesi sementara
    // (login dan halaman member berjalan seperti biasa tanpa cek database).
    const ENFORCE = true;

    const KEY = "portal_session_token";
    const LOGIN_PAGE = "login-member.html";
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

    // Dipanggil di login-member.js SETELAH signIn berhasil.
    // Mengembalikan kode dari database:
    //   "ok" = sesi berhasil diklaim
    //   "active" = akun masih aktif di tab/perangkat lain
    //   "locked" = akun dikunci admin
    //   "not_member" / "no_profile" = bukan member / profil tidak ada
    async function claim(client) {
        if (!ENFORCE) { sessionStorage.setItem(KEY, "off"); return "ok"; }
        const token = makeUUID();
        const { data, error } = await client.rpc("claim_login", { p_token: token });
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
        const memberTab = !!getToken();
        return window.supabase.createClient(
            url, key,
            memberTab ? { auth: { storage: window.sessionStorage } } : undefined
        );
    }

    return { claim, release, isValid, guard, getToken, createClient };
})();
