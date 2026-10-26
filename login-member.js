/**
 * ============================================================================
 * LOGIN MEMBER SCRIPT (SINGLE SESSION ENFORCEMENT)
 * Butuh: config.js (sudah memuat SingleSession) lalu supabase-js
 * ============================================================================
 */

// sessionStorage: tiap tab punya sesi sendiri
const supabaseClient = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY,
    {
        auth: {
            storage: window.sessionStorage
        }
    }
);

const loginForm = document.getElementById("loginForm");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const messageBox = document.getElementById("message");
const loginButton = document.getElementById("loginButton");

function showMessage(text, type) {
    messageBox.style.display = "block";
    messageBox.className = `message ${type}`;
    messageBox.textContent = text;
}

// Penanda versi: judul tab berakhiran " • v3" kalau file ini yang terpakai
document.title = document.title.replace(/ • v\d+$/, "") + " • v3";

// Deteksi kode sesi (dari config.js) yang tidak terbaca: config.js masih versi lama
const sessionReady = (typeof SingleSession !== "undefined");
if (!sessionReady) {
    showMessage("Kode sesi tidak terbaca: config.js yang terpasang masih versi lama. Ganti config.js dengan versi terbaru, lalu muat ulang dengan Ctrl+Shift+R.", "error");
    loginButton.disabled = true;
}

// Pesan jika dilempar balik dari halaman member
const urlParams = new URLSearchParams(window.location.search);
if (sessionReady && urlParams.get("reason") === "session") {
    const kodeInfo = " [kode: " + (urlParams.get("why") || "-") + ", dari: " + (urlParams.get("from") || "-") + "]";
    if (urlParams.get("why") === "no_token") {
        showMessage("Sesi login tidak ditemukan di tab ini (halaman dibuka tanpa login, atau tab baru). Silakan login kembali." + kodeInfo, "error");
    } else {
        showMessage("Sesi kamu berakhir karena akun direset oleh Admin atau dibuka di tempat lain. Silakan login kembali." + kodeInfo, "error");
    }
}

// Jika tab ini sudah punya sesi yang sah, langsung masuk.
// Jika ada sesi tapi tidak punya token klaim, bersihkan (hanya lokal).
async function checkExistingSession() {
    if (!sessionReady) return;
    const { data } = await supabaseClient.auth.getSession();
    if (!data || !data.session) return;

    if (SingleSession.getToken() && await SingleSession.isValid(supabaseClient)) {
        window.location.href = "member.html";
    } else {
        await supabaseClient.auth.signOut({ scope: "local" });
    }
}
checkExistingSession();

loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!sessionReady) return;

    const rawUsername = usernameInput.value.trim().toLowerCase();
    const password = passwordInput.value;

    if (!rawUsername || !password) {
        showMessage("Username dan password wajib diisi.", "error");
        return;
    }

    const emailForLogin = `${rawUsername}@portal.local`;

    showMessage("Mencoba masuk...", "loading");
    loginButton.disabled = true;
    loginButton.textContent = "Memproses...";

    try {
        // 1. Autentikasi Supabase Auth
        const { data: authData, error: authError } = await supabaseClient.auth.signInWithPassword({
            email: emailForLogin,
            password: password
        });

        if (authError) throw new Error("Username atau password salah.");

        // 2. Ambil profil
        const { data: profile, error: profileError } = await supabaseClient
            .from("profiles")
            .select("status, role")
            .eq("id", authData.user.id)
            .maybeSingle();

        // PENTING: signOut selalu scope "local". Default (global) akan
        // mematikan sesi di perangkat lain yang sedang sah!
        if (profileError || !profile) {
            await supabaseClient.auth.signOut({ scope: "local" });
            throw new Error("Gagal memverifikasi profil member.");
        }

        const role = String(profile.role || "").toLowerCase().trim();
        const status = String(profile.status || "").toLowerCase().trim();

        // 3. Validasi role
        if (role !== "member") {
            await supabaseClient.auth.signOut({ scope: "local" });
            throw new Error("Akun ini bukan akun member.");
        }

        // 4. Validasi status dari admin
        if (status !== "open") {
            await supabaseClient.auth.signOut({ scope: "local" });
            throw new Error("Akun Anda sedang dikunci oleh Admin.");
        }

        // 5. Klaim sesi (atomik di database)
        let claimResult;
        try {
            claimResult = await SingleSession.claim(supabaseClient);
        } catch (claimError) {
            console.error("CLAIM ERROR:", claimError);
            await supabaseClient.auth.signOut({ scope: "local" });
            throw new Error("Gagal mengamankan sesi login: " + (claimError.message || "kesalahan database") + " (pastikan SQL setup sudah dijalankan)");
        }

        if (claimResult !== "ok") {
            await supabaseClient.auth.signOut({ scope: "local" });
            if (claimResult === "active") {
                throw new Error("Akun masih dalam status login di tab atau perangkat lain! Keluar dulu di sana lewat tombol Keluar. Jika tab sebelumnya tertutup tanpa keluar, minta Admin untuk mereset status login akun kamu.");
            }
            if (claimResult === "locked") throw new Error("Akun Anda sedang dikunci oleh Admin.");
            if (claimResult === "not_member") throw new Error("Akun ini bukan akun member.");
            throw new Error("Gagal memverifikasi profil member.");
        }

        showMessage("Login berhasil! Mengalihkan...", "success");
        loginButton.textContent = "Berhasil!";

        setTimeout(() => {
            document.body.classList.add("page-exit");
            setTimeout(() => {
                window.location.href = "member.html";
            }, 380);
        }, 800);

    } catch (error) {
        console.error("LOGIN ERROR:", error);
        showMessage(error.message, "error");
        loginButton.disabled = false;
        loginButton.textContent = "Masuk";
    }
});
