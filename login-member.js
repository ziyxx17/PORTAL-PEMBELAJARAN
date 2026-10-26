/* =====================================================
   SINGLE SESSION - 1 akun hanya boleh aktif di 1 tab/perangkat
   Taruh sejajar dengan config.js, lalu load SETELAH library Supabase.
===================================================== */
const SingleSession = (function () {
    const KEY = "portal_session_token";
    const LOGIN_PAGE = "login-member.html";
    let timer = null;
    let ended = false;

    function getToken() {
        return sessionStorage.getItem(KEY);
    }

    // Dipanggil di login-member.js SETELAH signIn berhasil.
    // true  = sesi berhasil diklaim
    // false = akun masih aktif di tab/perangkat lain
    async function claim(client) {
        const token = crypto.randomUUID();
        const { data, error } = await client.rpc("claim_login", { p_token: token });
        if (error) throw error;
        if (data === true) {
            sessionStorage.setItem(KEY, token);
            return true;
        }
        return false;
    }

    // Dipanggil oleh tombol Keluar / Logout.
    async function release(client) {
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
        window.location.href = LOGIN_PAGE + "?reason=session&why=" + (why || "revoked");
    }

    // Pasang di setiap halaman member. Pindah tab TIDAK mengunci akun;
    // yang dicek hanya apakah token tab ini masih sah di database.
    async function guard(client, intervalMs) {
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
