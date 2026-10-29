/**
 * LOGIN TERPADU: Member / Moderator / Admin dalam satu halaman.
 * Butuh: config.js (memuat SingleSession dan Perm), lalu supabase-js.
 */
const SESSION_OPT = { auth: { storage: window.sessionStorage } };
let memberClient = null;
let staffClient = null;
function getMemberClient() {
    return memberClient || (memberClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SESSION_OPT));
}
function getStaffClient() {
    return staffClient || (staffClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY));
}

const loginForm = document.getElementById("loginForm");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const messageBox = document.getElementById("message");
const loginButton = document.getElementById("loginButton");

let currentRole = "member";
const NAMA_PERAN = { member: "Member", moderator: "Moderator", admin: "Admin" };

function showMessage(text, type) {
    messageBox.style.display = "block";
    messageBox.className = "message " + type;
    messageBox.textContent = text;
}

document.title = document.title.replace(/ • v\d+$/, "") + " • v4";
const sessionReady = (typeof SingleSession !== "undefined");

/* ---------- Pilih peran ---------- */
document.querySelectorAll(".role-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
        currentRole = tab.dataset.role;
        document.querySelectorAll(".role-tab").forEach(function (t) { t.classList.toggle("active", t === tab); });
        messageBox.style.display = "none";
        usernameInput.focus();
    });
});

/* ---------- Pesan jika dilempar dari halaman member ---------- */
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get("reason") === "session") {
    const kodeInfo = " [kode: " + (urlParams.get("why") || "-") + ", dari: " + (urlParams.get("from") || "-") + "]";
    showMessage(urlParams.get("why") === "no_token"
        ? "Sesi login tidak ditemukan di tab ini. Silakan login kembali." + kodeInfo
        : "Sesi kamu berakhir karena akun direset oleh Admin atau dibuka di tempat lain. Silakan login kembali." + kodeInfo, "error");
}

/* ---------- Sudah login? langsung masuk ---------- */
async function checkExistingSession() {
    try {
        if (sessionReady) {
            const mc = getMemberClient();
            const { data } = await mc.auth.getSession();
            if (data && data.session) {
                if (SingleSession.getToken() && await SingleSession.isValid(mc)) { window.location.href = "member.html"; return; }
                await mc.auth.signOut({ scope: "local" });
            }
        }
        if (urlParams.get("reason")) return;
        if (localStorage.getItem("admin_logged_in") === "true") {
            const sc = getStaffClient();
            const { data: s } = await sc.auth.getSession();
            if (s && s.session) {
                const { data: p } = await sc.from("profiles").select("role, status").eq("id", s.session.user.id).maybeSingle();
                const r = String(p && p.role || "").toLowerCase();
                if (p && (r === "admin" || r === "moderator") && String(p.status).toLowerCase() === "open") {
                    window.location.href = "admin.html";
                }
            }
        }
    } catch (e) { console.error("checkExistingSession:", e); }
}
checkExistingSession();

/* ---------- Alur Member (1 akun = 1 sesi) ---------- */
async function loginMember(username, password) {
    if (!sessionReady) throw new Error("Kode sesi tidak terbaca: config.js masih versi lama. Ganti config.js lalu tekan Ctrl+Shift+R.");
    const mc = getMemberClient();
    const { data: authData, error: authError } = await mc.auth.signInWithPassword({ email: username + "@portal.local", password: password });
    if (authError) throw new Error("Username atau password salah.");

    const { data: profile, error: profileError } = await mc.from("profiles").select("status, role").eq("id", authData.user.id).maybeSingle();
    if (profileError || !profile) { await mc.auth.signOut({ scope: "local" }); throw new Error("Gagal memverifikasi profil member."); }

    const role = String(profile.role || "").toLowerCase().trim();
    const status = String(profile.status || "").toLowerCase().trim();
    if (role !== "member") { await mc.auth.signOut({ scope: "local" }); throw new Error("Akun ini bukan akun Member. Pilih peran yang sesuai di atas."); }
    if (status !== "open") { await mc.auth.signOut({ scope: "local" }); throw new Error("Akun Anda sedang dikunci oleh Admin."); }

    let result;
    try { result = await SingleSession.claim(mc); }
    catch (e) {
        await mc.auth.signOut({ scope: "local" });
        throw new Error("Gagal mengamankan sesi login: " + (e.message || "kesalahan database"));
    }
    if (result !== "ok") {
        await mc.auth.signOut({ scope: "local" });
        if (result === "active") throw new Error("Akun masih dalam status login di tab atau perangkat lain! Keluar dulu di sana lewat tombol Keluar. Jika tab sebelumnya tertutup tanpa keluar, minta Admin untuk mereset status login akun kamu.");
        if (result === "locked") throw new Error("Akun Anda sedang dikunci oleh Admin.");
        if (result === "not_member") throw new Error("Akun ini bukan akun Member.");
        throw new Error("Gagal memverifikasi profil member.");
    }
    return "member.html";
}

/* ---------- Alur Moderator / Admin (lewat fungsi server admin-login) ---------- */
async function loginStaff(username, password, role) {
    const sc = getStaffClient();
    const { data, error } = await sc.functions.invoke("admin-login", { body: { username: username, password: password, role: role } });
    if (error) {
        let msg = "Username atau password salah.";
        try { const b = await error.context.json(); if (b && b.error) msg = b.error; } catch (e) {}
        throw new Error(msg);
    }
    if (!data || !data.success) throw new Error((data && (data.error || data.message)) || "Login gagal.");

    if (data.session) {
        const { error: sErr } = await sc.auth.setSession({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
        if (sErr) throw new Error("Gagal menyimpan sesi login.");
    }
    if (data.user) localStorage.setItem("portal_user", JSON.stringify(data.user));
    localStorage.setItem("admin_logged_in", "true");
    localStorage.setItem("portal_role", role);
    return "admin.html";
}

/* ---------- Submit ---------- */
loginForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    const username = usernameInput.value.trim().toLowerCase();
    const password = passwordInput.value;
    if (!username || !password) { showMessage("Username dan password wajib diisi.", "error"); return; }

    showMessage("Mencoba masuk sebagai " + NAMA_PERAN[currentRole] + "...", "loading");
    loginButton.disabled = true;
    loginButton.textContent = "Memproses...";

    try {
        const tujuan = currentRole === "member"
            ? await loginMember(username, password)
            : await loginStaff(username, password, currentRole);

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
