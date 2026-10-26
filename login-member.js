/**
 * ============================================================================
 * LOGIN MEMBER SCRIPT (SINGLE SESSION ENFORCEMENT)
 * ============================================================================
 */

// Gunakan sessionStorage agar tiap tab terisolasi dengan baik
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

// Cek sesi lokal di tab ini
async function checkExistingSession() {
    const { data } = await supabaseClient.auth.getSession();
    if (data && data.session) {
        window.location.href = "member.html"; 
    }
}
checkExistingSession();

loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();

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

        // 2. Ambil data profil dari database
        const { data: profile, error: profileError } = await supabaseClient
            .from("profiles")
            .select("status, role, is_logged_in")
            .eq("id", authData.user.id)
            .maybeSingle();

        if (profileError || !profile) {
            await supabaseClient.auth.signOut();
            throw new Error("Gagal memverifikasi profil member.");
        }

        const role = String(profile.role || "").toLowerCase().trim();
        const status = String(profile.status || "").toLowerCase().trim();

        // 3. VALIDASI ROLE
        if (role !== "member") {
            await supabaseClient.auth.signOut();
            throw new Error("Akun ini bukan akun member.");
        }

        // 4. VALIDASI STATUS DARI ADMIN
        if (status !== "open") {
            await supabaseClient.auth.signOut();
            throw new Error("Akun Anda sedang dikunci oleh Admin.");
        }

        // 5. VALIDASI IS_LOGGED_IN (MENCEGAH DOUBLE LOGIN / LUPA LOGOUT)
        if (profile.is_logged_in === true) {
            await supabaseClient.auth.signOut();
            throw new Error("Akun masih dalam status login di tab atau perangkat lain! Jika kamu tidak sengaja menutup tab sebelumnya, silakan minta Admin untuk mereset status login akun kamu.");
        }

        // 6. UPDATE STATUS LOGIN MENJADI TRUE
        const { error: updateError } = await supabaseClient
            .from("profiles")
            .update({ is_logged_in: true })
            .eq("id", authData.user.id);

        if (updateError) {
            console.error("Gagal update status login:", updateError.message);
            await supabaseClient.auth.signOut();
            throw new Error("Gagal mengamankan sesi login. Cek izin RLS Database.");
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
