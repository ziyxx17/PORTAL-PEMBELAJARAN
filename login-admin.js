console.log("login-admin.js berhasil dimuat");

/* =====================================================
   LOAD SUPABASE SDK DYNAMICALLY
===================================================== */
const script = document.createElement("script");
script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
script.onload = initAdminLogin;
document.head.appendChild(script);

/* =====================================================
   INIT ADMIN LOGIN
===================================================== */
function initAdminLogin() {
    const supabase = window.supabase.createClient(
        SUPABASE_URL,
        SUPABASE_PUBLISHABLE_KEY
    );

    /* =================================================
       DOM ELEMENTS
    ================================================= */
    const form = document.getElementById("loginForm");
    const message = document.getElementById("message");
    const button = document.getElementById("loginButton");

    if (!form || !message || !button) {
        console.error("Elemen login tidak ditemukan.");
        return;
    }

    const originalButtonText = button.textContent || "Masuk";

    /* =================================================
       SUBMIT LOGIN EVENT LISTENER
    ================================================= */
    form.addEventListener("submit", async function (event) {
        event.preventDefault();

        const usernameInput = document.getElementById("username");
        const passwordInput = document.getElementById("password");

        const username = usernameInput ? usernameInput.value.trim() : "";
        const password = passwordInput ? passwordInput.value : "";

        /* =========================================
           VALIDASI INPUT KOSONG
        ========================================= */
        if (!username || !password) {
            showMessage("Username dan password wajib diisi.", "error");
            return;
        }

        /* =========================================
           STATE LOADING
        ========================================= */
        showMessage("Memeriksa akun admin...", "loading");
        button.disabled = true;
        button.textContent = "Memeriksa...";

        try {
            /* =====================================
               PANGGIL EDGE FUNCTION ADMIN-LOGIN
            ===================================== */
            const { data, error } = await supabase.functions.invoke(
                "admin-login",
                {
                    body: { username, password }
                }
            );

            /* =====================================
               EVALUASI HASIL RESPONS FUNCTION
            ===================================== */
            if (error || !data || !data.success) {
                console.error("FUNCTION ERROR / LOGIN GAGAL:", error || data);
                const errMsg = (data && data.message) ? data.message : "Username atau password salah.";
                throw new Error(errMsg);
            }

            /* =====================================
               SET SESI SUPABASE AUTH
            ===================================== */
            if (data.session) {
                const { error: sessionError } = await supabase.auth.setSession({
                    access_token: data.session.access_token,
                    refresh_token: data.session.refresh_token
                });

                if (sessionError) {
                    console.error("SESSION ERROR:", sessionError);
                    throw new Error("Gagal menyimpan sesi login admin.");
                }
            }

            /* =====================================
               SIMPAN SESI & FLAG KE LOCALSTORAGE
            ===================================== */
            if (data.user) {
                localStorage.setItem("portal_user", JSON.stringify(data.user));
            }
            
            // Tandai flag status login admin aktif secara permanen di browser
            localStorage.setItem("admin_logged_in", "true");

            /* =====================================
               LOGIN BERHASIL
            ===================================== */
            showMessage("Login Admin berhasil. Mengalihkan...", "success");
            button.textContent = "Berhasil!";

            setTimeout(function () {
                window.location.href = "admin.html";
            }, 700);

        } catch (err) {
            console.error("LOGIN ERROR:", err);
            showMessage(err.message || "Username atau password salah.", "error");
            
            // Aktifkan kembali tombol jika terjadi kesalahan
            button.disabled = false;
            button.textContent = originalButtonText;
        }
    });

    /* =================================================
       HELPER: DISPLAY MESSAGE
    ================================================= */
    function showMessage(text, type) {
        message.style.display = "block";
        message.className = `message ${type}`;

        if (type === "success") {
            message.style.background = "#dcfce7";
            message.style.color = "#166534";
            message.style.border = "1px solid rgba(34, 197, 94, 0.35)";
        } else if (type === "loading") {
            message.style.background = "#e0f2fe";
            message.style.color = "#0369a1";
            message.style.border = "1px solid rgba(56, 189, 248, 0.35)";
        } else {
            message.style.background = "#fee2e2";
            message.style.color = "#991b1b";
            message.style.border = "1px solid rgba(239, 68, 68, 0.35)";
        }

        message.textContent = text;
    }
}
