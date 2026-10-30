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
                   "user-status", "admin-settings", "riwayat-login", "izin-peran", "absensi-admin", "subjects", "materials"];
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


/* HOME BAR "LIQUID GLASS" (gaya iPhone): menu bawah yang bisa digeser.
   Muncul otomatis di halaman member dan halaman admin/moderator. */
window.LiquidDock = (function () {
    const MEMBER = [
        { label: "Beranda", icon: "🏠", href: "member.html", pages: ["member"] },
        { label: "Jadwal", icon: "📅", href: "jadwal.html", pages: ["jadwal"] },
        { label: "Absensi", icon: "✅", href: "absensi.html", pages: ["absensi"] },
        { label: "Mapel", icon: "📚", href: "subjects.html", pages: ["subjects", "materials", "material-detail"] },
        { label: "Info", icon: "📢", href: "announcements.html", pages: ["announcements"] },
        { label: "Profil", icon: "👤", href: "profil-member.html", pages: ["profil-member"] }
    ];
    const STAFF = [
        { label: "Dashboard", icon: "🏠", href: "admin.html", pages: ["admin", "admin-settings", "izin-peran"] },
        { label: "Absensi", icon: "✅", href: "absensi-admin.html", pages: ["absensi-admin"], perm: "kelola_absensi" },
        { label: "Member", icon: "👥", href: "member-management.html", pages: ["member-management", "riwayat-login"], perm: "kelola_member" },
        { label: "Jadwal", icon: "📅", href: "kelola-jadwal.html", pages: ["kelola-jadwal"], perm: "kelola_jadwal" },
        { label: "Info", icon: "📢", href: "announcements-admin.html", pages: ["announcements-admin"], perm: "kelola_pengumuman" },
        { label: "Statistik", icon: "📊", href: "statistics.html", pages: ["statistics", "user-status"], perm: "lihat_statistik" }
    ];
    const CSS = `
.lg-dock{position:fixed;left:50%;bottom:calc(14px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:9000;display:flex;align-items:stretch;gap:2px;padding:7px;width:min(94vw,420px);border-radius:999px;touch-action:none;user-select:none;-webkit-user-select:none;cursor:grab;
background:linear-gradient(135deg,rgba(255,255,255,.2),rgba(255,255,255,.06) 55%,rgba(255,255,255,.14));
-webkit-backdrop-filter:blur(26px) saturate(190%);backdrop-filter:blur(26px) saturate(190%);
border:1px solid rgba(255,255,255,.3);
box-shadow:0 22px 44px -12px rgba(0,0,0,.6),inset 0 1.5px 0 rgba(255,255,255,.6),inset 0 -1px 0 rgba(255,255,255,.1),inset 0 0 22px rgba(255,255,255,.07);
animation:lgIn .7s cubic-bezier(.34,1.56,.64,1) both}
.lg-dock::before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:linear-gradient(115deg,rgba(255,255,255,.28) 0%,rgba(255,255,255,0) 38%)}
.lg-dock.drag{cursor:grabbing}
@keyframes lgIn{from{opacity:0;transform:translateX(-50%) translateY(40px) scale(.9)}to{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}}
.lg-lens{position:absolute;top:5px;bottom:5px;left:0;border-radius:999px;pointer-events:none;z-index:1;opacity:0;
background:linear-gradient(180deg,rgba(255,255,255,.34),rgba(255,255,255,.12));
-webkit-backdrop-filter:blur(6px) brightness(1.3);backdrop-filter:blur(6px) brightness(1.3);
border:1px solid rgba(255,255,255,.5);
box-shadow:inset 0 1.5px 1px rgba(255,255,255,.75),inset 0 -8px 14px rgba(255,255,255,.1),0 8px 20px rgba(0,0,0,.35);
transition:transform .5s cubic-bezier(.34,1.56,.64,1),width .3s,opacity .3s}
.lg-dock.drag .lg-lens{transition:width .3s,opacity .3s;filter:brightness(1.12)}
.lg-item{position:relative;z-index:2;flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;padding:7px 0 5px;color:#e2e8f0;text-decoration:none;-webkit-tap-highlight-color:transparent;transition:transform .35s cubic-bezier(.34,1.56,.64,1),color .2s}
.lg-item .ic{font-size:21px;line-height:1.1}
.lg-item small{font-size:9.5px;font-weight:700;letter-spacing:.01em;opacity:.85}
.lg-item.on{color:#fff}.lg-item.on small{opacity:1}
body.has-dock{padding-bottom:108px!important}
@media (prefers-reduced-motion:reduce){.lg-dock,.lg-lens,.lg-item{animation:none!important;transition:none!important}}`;

    const ref = (function () { try { return new URL(SUPABASE_URL).hostname.split(".")[0]; } catch (e) { return ""; } })();
    const KEY = "sb-" + ref + "-auth-token";
    function pageName() { return (window.location.pathname.split("/").pop() || "").replace(".html", ""); }
    function readSession() {
        try { const j = JSON.parse(sessionStorage.getItem(KEY) || "null"); return j && j.access_token && j.user ? j : null; }
        catch (e) { return null; }
    }
    async function call(path, s, body) {
        const r = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
            method: body ? "POST" : "GET",
            headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: "Bearer " + s.access_token, "Content-Type": "application/json" },
            body: body ? JSON.stringify(body) : undefined
        });
        return r.ok ? r.json() : null;
    }
    function activeIndex(items, p) {
        for (let i = 0; i < items.length; i++) if (items[i].pages.indexOf(p) >= 0) return i;
        return -1;
    }

    function mount(items, active) {
        const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
        const dock = document.createElement("nav");
        dock.className = "lg-dock"; dock.setAttribute("aria-label", "Navigasi utama");
        const lens = document.createElement("div"); lens.className = "lg-lens"; dock.appendChild(lens);
        const els = items.map(function (it) {
            const a = document.createElement("a");
            a.className = "lg-item"; a.href = it.href;
            a.innerHTML = '<span class="ic">' + it.icon + '</span><small>' + it.label + "</small>";
            dock.appendChild(a);
            return a;
        });
        document.body.appendChild(dock);
        document.body.classList.add("has-dock");

        let cur = active, drag = false, sx = 0, last = 0;
        const centerOf = function (k) { return els[k].offsetLeft + els[k].offsetWidth / 2; };
        const lensW = function () { return els[0].offsetWidth + 6; };
        function put(x, s) {
            const w = lensW();
            lens.style.width = w + "px";
            lens.style.transform = "translateX(" + (x - w / 2) + "px) scale(" + s + ")";
            lens.style.opacity = 1;
        }
        function snap(i) {
            put(centerOf(i), 1);
            els.forEach(function (e, k) { e.classList.toggle("on", k === i); e.style.transform = ""; });
        }
        function localX(cx) { const r = dock.getBoundingClientRect(); return cx - r.left - (dock.clientLeft || 0); }
        function follow(cx) {
            const x = Math.max(centerOf(0), Math.min(centerOf(els.length - 1), localX(cx)));
            put(x, 1.16);
            els.forEach(function (e, k) {
                const d = Math.abs(centerOf(k) - x) / els[k].offsetWidth;
                e.style.transform = "scale(" + (1 + Math.max(0, 1 - d) * 0.3) + ")";
            });
        }
        function nearest(cx) {
            const x = localX(cx); let b = 0, bd = 1e9;
            for (let k = 0; k < els.length; k++) { const d = Math.abs(centerOf(k) - x); if (d < bd) { bd = d; b = k; } }
            return b;
        }
        function go(href) {
            document.body.style.transition = "opacity .18s";
            document.body.style.opacity = "0";
            setTimeout(function () { window.location.href = href; }, 170);
        }
        function finish(cx, cancel) {
            if (!drag) return;
            drag = false; dock.classList.remove("drag");
            const i = cancel ? cur : nearest(cx);
            if (i < 0) { lens.style.opacity = 0; els.forEach(function (e) { e.style.transform = ""; }); return; }
            snap(i);
            if (cancel) return;
            last = Date.now();
            if (i !== cur) { cur = i; go(items[i].href); }
        }

        dock.addEventListener("pointerdown", function (e) {
            drag = true; sx = e.clientX;
            try { dock.setPointerCapture(e.pointerId); } catch (x) {}
            dock.classList.add("drag"); follow(e.clientX);
        });
        dock.addEventListener("pointermove", function (e) { if (drag) follow(e.clientX); });
        dock.addEventListener("pointerup", function (e) { finish(e.clientX, false); });
        dock.addEventListener("pointercancel", function (e) { finish(e.clientX, true); });
        els.forEach(function (a, k) {
            a.addEventListener("click", function (e) {
                e.preventDefault();                         // tombol keyboard (Enter) tetap bisa pindah
                if (Date.now() - last < 600) return;
                if (k !== cur) { cur = k; snap(k); go(items[k].href); }
            });
        });
        window.addEventListener("resize", function () { if (cur >= 0) snap(cur); });
        window.addEventListener("pageshow", function () { document.body.style.opacity = ""; });

        if (cur >= 0) requestAnimationFrame(function () { snap(cur); });
        return { dock: dock, lens: lens, els: els, snap: snap };
    }

    async function init() {
        const p = pageName();
        const s = readSession();
        if (!s) return;
        const rows = await call("profiles?select=role,status&id=eq." + s.user.id, s);
        const role = rows && rows[0] ? String(rows[0].role || "").toLowerCase() : "";
        const open = rows && rows[0] ? String(rows[0].status || "").toLowerCase() === "open" : false;
        if (!open) return;

        let items = null;
        if (role === "member" && activeIndex(MEMBER, p) >= 0) {
            items = MEMBER;
        } else if ((role === "admin" || role === "moderator") && (activeIndex(STAFF, p) >= 0 || p === "subjects" || p === "materials")) {
            items = [];
            for (const it of STAFF) {
                if (!it.perm || role === "admin") { items.push(it); continue; }
                const ok = await call("rpc/has_permission", s, { p_key: it.perm });
                if (ok === true) items.push(it);
            }
        }
        if (items && items.length >= 2) mount(items, activeIndex(items, p));
    }

    window.addEventListener("load", function () { setTimeout(init, 400); });
    return { _mount: mount };
})();
