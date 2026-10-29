/**
 * LOGIN TERPADU: Member / Moderator / Admin dalam satu halaman.
 * Semua peran memakai sesi per-tab (sessionStorage): membuka tab baru tidak
 * mengganggu tab lain, dan tab baru selalu menampilkan form login.
 * Member & Moderator: 1 akun = 1 sesi. Admin: tanpa batas.
 */
const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { storage: window.sessionStorage }
});

const loginForm = document.getElementById("loginForm");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const messageBox = document.getElementById("message");
const loginButton = document.getElementById("loginButton");

let currentRole = "member";
const NAMA_PERAN = { member: "Member", moderator: "Moderator", admin: "Admin" };
const TUJUAN = { member: "member.html", moderator: "admin.html", admin: "admin.html" };

function showMessage(text, type) {
    messageBox.style.display = "block";
    messageBox.className = "message " + type;
    messageBox.textContent = text;
}

document.title = document.title.replace(/ • v\d+$/, "") + " • v5";
const sessionReady = (typeof SingleSession !== "undefined");

document.querySelectorAll(".role-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
        currentRole = tab.dataset.role;
        document.querySelectorAll(".role-tab").forEach(function (t) { t.classList.toggle("active", t === tab); });
        messageBox.style.display = "none";
        usernameInput.focus();
    });
});

const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get("reason") === "session") {
    const kodeInfo = " [kode: " + (urlParams.get("why") || "-") + ", dari: " + (urlParams.get("from") || "-") + "]";
    showMessage(urlParams.get("why") === "no_token"
        ? "Sesi login tidak ditemukan di tab ini. Silakan login kembali." + kodeInfo
        : "Sesi kamu berakhir karena akun direset oleh Admin atau dibuka di tempat lain. Silakan login kembali." + kodeInfo, "error");
}

/* Hanya untuk TAB INI: jika tab ini sudah punya sesi sah, langsung lanjut.
   Tab baru tidak punya sesi, jadi tidak pernah dilempar ke halaman lain. */
async function checkExistingSession() {
    try {
        const { data } = await client.auth.getSession();
        if (!data || !data.session) return;
        if (urlParams.get("reason")) { await client.auth.signOut({ scope: "local" }); return; }

        const { data: p } = await client.from("profiles").select("role, status").eq("id", data.session.user.id).maybeSingle();
        const role = String(p && p.role || "").toLowerCase();
        const open = String(p && p.status || "").toLowerCase() === "open";

        if (open && role === "admin") { window.location.href = "admin.html"; return; }
        if (open && (role === "member" || role === "moderator") && sessionReady
            && SingleSession.getToken() && await SingleSession.isValid(client)) {
            window.location.href = TUJUAN[role];
            return;
        }
        await client.auth.signOut({ scope: "local" });
    } catch (e) { console.error("checkExistingSession:", e); }
}
checkExistingSession();

/* Member & Moderator: login langsung + klaim sesi (1 akun = 1 sesi) */
async function loginBatasSesi(username, password, wanted) {
    if (!sessionReady) throw new Error("Kode sesi tidak terbaca: config.js masih versi lama. Ganti config.js lalu tekan Ctrl+Shift+R.");

    const { data: authData, error: authError } = await client.auth.signInWithPassword({ email: username + "@portal.local", password: password });
    if (authError) throw new Error("Username atau password salah.");

    const { data: profile, error: profileError } = await client.from("profiles").select("status, role").eq("id", authData.user.id).maybeSingle();
    if (profileError || !profile) { await client.auth.signOut({ scope: "local" }); throw new Error("Gagal memverifikasi profil."); }

    const role = String(profile.role || "").toLowerCase().trim();
    const status = String(profile.status || "").toLowerCase().trim();
    if (role !== wanted) {
        await client.auth.signOut({ scope: "local" });
        throw new Error("Akun ini bukan akun " + NAMA_PERAN[wanted] + ". Pilih peran yang sesuai di atas.");
    }
    if (status !== "open") { await client.auth.signOut({ scope: "local" }); throw new Error("Akun Anda sedang dikunci oleh Admin."); }

    let result;
    try { result = await SingleSession.claim(client); }
    catch (e) {
        await client.auth.signOut({ scope: "local" });
        throw new Error("Gagal mengamankan sesi login: " + (e.message || "kesalahan database"));
    }
    if (result !== "ok") {
        await client.auth.signOut({ scope: "local" });
        if (result === "active") throw new Error("Akun masih dalam status login di tab atau perangkat lain! Keluar dulu di sana lewat tombol Keluar. Jika tab sebelumnya tertutup tanpa keluar, minta Admin untuk mereset status login akun kamu.");
        if (result === "locked") throw new Error("Akun Anda sedang dikunci oleh Admin.");
        if (result === "not_member") throw new Error("Akun ini bukan akun " + NAMA_PERAN[wanted] + ".");
        throw new Error("Gagal memverifikasi profil.");
    }
    return TUJUAN[wanted];
}

/* Admin: lewat fungsi server admin-login */
async function loginAdmin(username, password) {
    const { data, error } = await client.functions.invoke("admin-login", { body: { username: username, password: password, role: "admin" } });
    if (error) {
        let msg = "Username atau password salah.";
        try { const b = await error.context.json(); if (b && b.error) msg = b.error; } catch (e) {}
        throw new Error(msg);
    }
    if (!data || !data.success) throw new Error((data && (data.error || data.message)) || "Login gagal.");
    if (data.session) {
        const { error: sErr } = await client.auth.setSession({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
        if (sErr) throw new Error("Gagal menyimpan sesi login.");
    }
    return TUJUAN.admin;
}

loginForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    const username = usernameInput.value.trim().toLowerCase();
    const password = passwordInput.value;
    if (!username || !password) { showMessage("Username dan password wajib diisi.", "error"); return; }

    showMessage("Mencoba masuk sebagai " + NAMA_PERAN[currentRole] + "...", "loading");
    loginButton.disabled = true;
    loginButton.textContent = "Memproses...";

    try {
        const tujuan = currentRole === "admin"
            ? await loginAdmin(username, password)
            : await loginBatasSesi(username, password, currentRole);

        showMessage("Login berhasil! Mengalihkan...", "success");
        loginButton.textContent = "Berhasil!";
        setTimeout(function () {
            document.body.classList.add("page-exit");
            setTimeout(function () { window.location.href = tujuan; }, 380);
        }, 700);
    } catch (error) {
        console.error("LOGIN ERROR:", error);
        showMessage(error.message, "error");
        loginButton.disabled = false;
        loginButton.textContent = "Masuk";
    }
});
