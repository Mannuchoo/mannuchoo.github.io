const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"];
const isLocalFrontend = LOCAL_HOSTS.includes(window.location.hostname);
const isGitHubPages = !isLocalFrontend;
const DEFAULT_GITHUB_PAGES_API_BASE = "http://148.230.70.64:3000";

function applyBackendUrlFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const backend = resolveBackendUrl(params.get("backend") || params.get("api"));
    if (!backend) return "";
    localStorage.setItem("backend_url_override", backend);
    params.delete("backend");
    params.delete("api");
    const nextQuery = params.toString();
    const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", nextUrl);
    return backend;
}

function getSavedBackendUrl() {
    return localStorage.getItem("backend_url_override") || "";
}

function resolveBackendUrl(rawUrl) {
    if (!rawUrl) return "";
    const trimmed = rawUrl.trim();
    if (!trimmed) return "";
    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
        return `https://${trimmed}`;
    }
    return trimmed.replace(/\/+$/, "");
}

function showBackendSetupPrompt() {
    if (!isGitHubPages) return;
    if (window.API_BASE) return;
    if (document.getElementById("ghBackendSetupPrompt")) return;

    const existing = getSavedBackendUrl();
    const banner = document.createElement("div");
    banner.id = "ghBackendSetupPrompt";
    banner.style = `
        position: fixed;
        top: 16px;
        left: 50%;
        transform: translateX(-50%);
        width: min(100%, 520px);
        z-index: 99999;
        background: rgba(11, 20, 29, 0.98);
        border: 1px solid rgba(0,255,136,0.45);
        border-radius: 18px;
        padding: 18px 20px;
        color: white;
        box-shadow: 0 18px 45px rgba(0,0,0,0.45);
        font-family: Inter, sans-serif;
    `;
    banner.innerHTML = `
        <div style="display:flex; align-items:flex-start; gap: 14px; flex-wrap:wrap;">
            <div style="flex:1; min-width:220px;">
                <strong style="font-size:1rem; color:#00ff88;">GitHub Pages Backend Required</strong>
                <p style="margin: 8px 0 12px; color:#b7d8c8; font-size:0.92rem; line-height:1.45;">
                    This site needs a live backend URL. Enter an override URL below only if the default backend is unavailable.
                </p>
            </div>
            <button id="ghBackendSetupCloseBtn" style="border:none; background:transparent; color:#8b98a5; font-size:1.2rem; cursor:pointer;">✕</button>
        </div>
        <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
            <input id="ghBackendUrlInput" placeholder="https://xxxxx.ngrok-free.app" value="${existing}" style="flex:1; min-width:220px; border-radius:12px; border:1px solid rgba(255,255,255,0.12); background:#0b0c10; color:white; padding:12px 14px; font-size:0.95rem;" />
            <button id="ghBackendSetupSaveBtn" style="border:none; border-radius:12px; padding:12px 18px; background:#00ff88; color:#050505; font-weight:800; cursor:pointer;">Save</button>
            <button id="ghBackendSetupClearBtn" style="border:none; border-radius:12px; padding:12px 18px; background:#1c1d22; color:#ccc; cursor:pointer;">Clear</button>
        </div>
        <div id="ghBackendSetupMessage" style="margin-top:12px; color:#d4d4d4; font-size:0.88rem;"></div>
    `;

    document.body.appendChild(banner);

    document.getElementById("ghBackendSetupCloseBtn").onclick = () => banner.remove();
    document.getElementById("ghBackendSetupSaveBtn").onclick = () => {
        const input = document.getElementById("ghBackendUrlInput");
        const rawUrl = input.value;
        const resolved = resolveBackendUrl(rawUrl);
        const msg = document.getElementById("ghBackendSetupMessage");
        if (!resolved) {
            msg.textContent = "Enter a valid ngrok URL to continue.";
            return;
        }
        localStorage.setItem("backend_url_override", resolved);
        msg.textContent = "Saved! Reloading page...";
        setTimeout(() => location.reload(), 800);
    };
    document.getElementById("ghBackendSetupClearBtn").onclick = () => {
        localStorage.removeItem("backend_url_override");
        document.getElementById("ghBackendUrlInput").value = "";
        document.getElementById("ghBackendSetupMessage").textContent = "Backend URL cleared.";
    };
}

function getApiBase() {
    const queryBackend = applyBackendUrlFromQuery();
    if (queryBackend) return queryBackend;

    const saved = getSavedBackendUrl();
    if (saved) return resolveBackendUrl(saved);

    if (isGitHubPages) {
        if (DEFAULT_GITHUB_PAGES_API_BASE) return DEFAULT_GITHUB_PAGES_API_BASE;
        if (document.readyState !== "loading") {
            showBackendSetupPrompt();
        } else {
            window.addEventListener("DOMContentLoaded", showBackendSetupPrompt);
        }
        return "";
    }
    return window.location.origin;
}

window.API_BASE = getApiBase();

function apiUrl(path) {
    if (!path) return window.API_BASE || window.location.origin;
    if (/^https?:\/\//i.test(path)) return path;
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return `${window.API_BASE || window.location.origin}${normalized}`;
}

window.apiUrl = apiUrl;

function assetUrl(path, fallback = "") {
    const value = path || fallback;
    if (!value) return "";
    if (/^(data:|blob:|https?:\/\/)/i.test(value)) return value;
    return apiUrl(value);
}

window.assetUrl = assetUrl;

function getToken() {
    return localStorage.getItem("token");
}

async function apiFetch(endpoint, options = {}) {
    // Check if backend is configured when on GitHub Pages
    if (isGitHubPages && !window.API_BASE) {
        showBackendSetupPrompt();
        throw new Error("Backend not configured for GitHub Pages. Start the PolySoko backend or set localStorage.backend_url_override and reload.");
    }

    const token = localStorage.getItem("token");
    // Standardize pathing: ensure no double slashes and always starts with /api/
    const cleanEndpoint = (endpoint || '').replace(/^\/?(api\/)?/, '');
    const path = `/api/${cleanEndpoint}`;
    
    const url = `${window.API_BASE}${path}`;
    const headers = {
        'Content-Type': 'application/json',
        'Bypass-Tunnel-Reminder': 'true',
        'ngrok-skip-browser-warning': 'true',
        ...options.headers
    };

    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    const defaultOptions = {
        method: options.method || 'GET',
        headers,
    };

    if (options.body) {
        defaultOptions.body = typeof options.body === 'string' 
            ? options.body 
            : JSON.stringify(options.body);
    }

    let res;
    try {
        res = await fetch(url, defaultOptions);
    } catch (err) {
        console.error("❌ Network Error:", err);
        throw new Error("Unable to connect to the server. Please check your internet or tunnel status.");
    }

    if (res.status === 401) {
        // Only logout if the core session-based routes fail 401
        const criticalRoutes = ['profile', 'user/history', 'my-bets'];
        if (criticalRoutes.some(r => (endpoint || '').toLowerCase().includes(r))) {
            localStorage.removeItem("token");
            window.location.href = "login.html";
        }
        throw new Error("Unauthorized access or session expired.");
    }

    const text = await res.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        console.error("❌ Failed to parse JSON. Response body preview:", text.slice(0, 200));
        if (text.toLowerCase().includes("<html")) {
            throw new Error("Server returned HTML instead of JSON. Check your backend URL configuration.");
        }
        throw new Error("Server returned an invalid non-JSON response.");
    }

    if (!res.ok) throw new Error(data.message || `API Error (${res.status})`);
    return data;
}
async function fetchProfile() {
    // Use the name directly, helper will prepend /api/
    const data = await apiFetch('profile'); 
    
    if (data && data.success && data.user) {
        const u = data.user;
        // Update greeting and balance
        if (document.getElementById("userName")) document.getElementById("userName").innerText = u.name;
        if (document.getElementById("userNameHeader")) document.getElementById("userNameHeader").innerText = u.name || "User";

        // Inject Admin Emoji Button near Balance Card
        const balRow = document.getElementById('balAdminRow');
        if (balRow && (u.role === 'admin' || Number(u.is_upgraded) === 1)) { 
            if (!document.getElementById('dashAdminBtn')) {
                const adminBtn = document.createElement('button');
                adminBtn.id = 'dashAdminBtn';
                adminBtn.style = 'background:#00ff88; color:black; width:58px; height:58px; border-radius:18px; border:none; font-size:1.5rem; cursor:pointer; display:flex; align-items:center; justify-content:center; box-shadow: 0 4px 20px rgba(0,255,136,0.3); z-index:10; margin-left:8px;';
                adminBtn.innerHTML = '⚙️';
                adminBtn.onclick = (e) => { 
                    e.stopPropagation();
                    window.openAdminPanel ? window.openAdminPanel() : window.location.href = '/admin.html'; 
                };
                balRow.appendChild(adminBtn);
            }
        }
        if (document.getElementById("userPhoneDisplay")) {
            document.getElementById("userPhoneDisplay").innerHTML = u.phone 
                ? `<span onclick="window.location.href='tel:${u.phone}'" style="cursor:pointer; margin-right:8px;">📞</span> <a href="tel:${u.phone}" style="color:inherit;text-decoration:none;">${u.phone}</a>` 
                : `<span style="margin-right:8px; opacity:0.5;">📞</span> ---`;
        }
        if (document.getElementById("userEmailDisplay")) {
            const emailAction = u.email ? `<a href="mailto:${u.email}" style="color:inherit;text-decoration:none;">${u.email}</a>` : "Add email";
            document.getElementById("userEmailDisplay").innerHTML = `<span onclick="window.showEmailEdit()" style="cursor:pointer; margin-right:8px;">✉️</span> ${emailAction} <span onclick="window.showEmailEdit()" style="cursor:pointer; margin-left:8px; opacity:0.8;">✏️</span>`;
        }
        if (document.getElementById("editName")) document.getElementById("editName").value = u.name || "";
        // Hide the old static save button area
        const staticSave = document.querySelector('.profile-edit-section');
        if (staticSave) staticSave.style.display = 'none';

        // Inject UPGRADE 🚀 Button into profile area (with fallback)
        const isUpgraded = u.is_upgraded === 1;
        const btnHtml = `
            <button id="upgradeBtn" onclick="window.startUpgradeFlow()" style="width:100%; padding: 18px; border-radius: 12px; border: none; font-weight: 900; cursor: pointer; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 20px; transition: 0.3s; ${isUpgraded ? 'background: rgba(0,255,136,0.1); color: #00ff88; border: 1px solid #00ff88;' : 'background: linear-gradient(90deg, #00ff88, #00ccff); color: black; box-shadow: 0 0 25px rgba(0,255,136,0.5);'}">
                ${isUpgraded ? 'ELITE ACTIVE 💎' : 'UPGRADE ⚡'}
            </button>`;

        if (u.role !== 'admin') {
            const upgradeArea = document.getElementById("upgradeArea");
            if (upgradeArea) {
                upgradeArea.innerHTML = btnHtml;
            } else {
                // Fallback: place in main actions area if profile module didn't render yet
                const actions = document.getElementById('userActionsArea') || document.getElementById('userActions');
                if (actions) {
                    // prepend so primary actions remain visible
                    actions.insertAdjacentHTML('afterbegin', btnHtml);
                }
            }
        }

        localStorage.setItem("user_data", JSON.stringify(u));
        
        // Hide referral code if unverified
        // This is not the balance card, so no change here.
        const refEl = document.getElementById("referralCodeDisplay");
        if (refEl) {
            refEl.innerText = u.status === 'verified' ? u.referral_code : "Verify email to see code";
        }

        // Show M-Pesa Log button if Admin
        if (u.role === 'admin') {
            const adminArea = document.getElementById("adminActionsArea");
            if (adminArea) {
                adminArea.innerHTML = `
                    <button onclick="location.href='admin.html'" class="pill active" style="width:100%; margin-top:10px; background:#da020e; color:white; font-weight:900; letter-spacing:1px; box-shadow: 0 4px 15px rgba(218, 2, 14, 0.3);">⚙️ ENTER MANAGEMENT CONSOLE</button>
                    <button onclick="window.showUserManagement()" class="pill active" style="width:100%; margin-top:10px; background:#00ff88; color:black; font-weight:bold;">👥 MANAGE USER DIRECTORY</button>
                    <button onclick="window.openMpesaDashboard('withdraw')" class="pill active" style="width:100%; margin-top:10px; background:#3b82f6; color:white; font-weight:bold;">💸 WITHDRAWAL REQUESTS</button>
                    <button onclick="window.openMpesaDashboard('deposit')" class="pill active" style="width:100%; margin-top:10px; background:#00ff88; color:black; font-weight:bold;">💰 DEPOSIT MPESA LOG</button>
                `;
            }
        }

        if (document.getElementById("roleBadge")) document.getElementById("roleBadge").innerText = (u.role || "user").toUpperCase();
        // Fix: Prepend API_BASE for images when hosted on GitHub Pages

        const defaultAvatar = "uploads/avatars/default.png";
        const avatarUrl = assetUrl(u.avatar_url, defaultAvatar);
        const fallbackAvatarUrl = assetUrl(defaultAvatar);
        if (document.getElementById("userAvatar")) {
            document.getElementById("userAvatar").src = avatarUrl;
            document.getElementById("userAvatar").onerror = function() { this.onerror = null; this.src = fallbackAvatarUrl; };
        }
        if (document.getElementById("headerAvatar")) {
            document.getElementById("headerAvatar").src = avatarUrl;
            document.getElementById("headerAvatar").onerror = function() { this.onerror = null; this.src = fallbackAvatarUrl; };
        }
        localStorage.setItem('saved_avatar_url', avatarUrl);
    }
}

function restoreSavedAvatar() {
    const avatarUrl = localStorage.getItem('saved_avatar_url');
    if (!avatarUrl) return;
    const normalized = assetUrl(avatarUrl);
    if (document.getElementById("userAvatar")) document.getElementById("userAvatar").src = normalized;
    if (document.getElementById("headerAvatar")) document.getElementById("headerAvatar").src = normalized;
}

window.addEventListener('DOMContentLoaded', () => {
    restoreSavedAvatar();
    // Automatically overhaul the UI if we are on the login page or a form is present
    if (window.location.pathname.includes('login') || window.location.pathname.includes('reset') || document.getElementById('phone')) {
        showWelcomeHeader();
    }
});

/**
 * LOGIN
 */
async function login(payload) {
    return apiFetch('login', { method: 'POST', body: payload });
}

/**
 * REGISTER
 */
async function register(payload) {
    return apiFetch('register', { method: 'POST', body: payload });
}

/**
 * RESET
 */
async function resetPassword(token, newPassword, otp) {
    return apiFetch('reset-password', {
        method: 'POST',
        body: { token, newPassword, otp }
    });
}

window.showWelcomeHeader = function() {
    const welcome = document.getElementById('loginWelcome') || document.querySelector('h2');
    if (welcome) {
        welcome.id = 'loginWelcome';
        welcome.innerText = "Welcome to POLYSOKO. Soko ni Soko.";
        welcome.style.color = "#00ff88";
        welcome.style.textShadow = "0 0 15px rgba(0, 255, 136, 0.6)";
        welcome.style.opacity = "0";
        welcome.style.transition = "opacity 1.5s ease-in, transform 1s ease-out";
        welcome.style.transform = "translateY(-10px)";
        setTimeout(() => {
            welcome.style.opacity = '1';
            welcome.style.transform = "translateY(0)";
        }, 100);
    }
};

async function updateEmail(email) {
    return apiFetch('user/update-email', {
        method: "POST",
        body: { email }
    });
}

async function upgradeAccount() {
    return apiFetch('user/upgrade', {
        method: 'POST',
        body: {}
    });
}

async function adminCreateMarket(payload) {
    // If payload is submitted by an admin, use the direct admin route
    const userData = JSON.parse(localStorage.getItem("user_data") || "{}");
    const endpoint = userData.role === 'admin' ? 'admin/create-market' : 'user/submit-market';
    
    return apiFetch(endpoint, {
        method: 'POST',
        body: payload
    });
}

async function depositCrypto(payload) {
    return apiFetch('user/deposit-crypto', {
        method: 'POST',
        body: payload
    });
}

async function deleteNotification(id) {
    return apiFetch(`notifications/${id}`, { method: 'DELETE' });
}

async function markNotificationsRead() {
    return apiFetch('notifications/read-all', { method: 'POST' });
}

async function updateProfile(payload) {
    return apiFetch('user/update', {
        method: 'POST',
        body: payload
    });
}

async function fetchMpesaLog() {
    return apiFetch('admin/mpesa-log');
}

/**
 * TRANSACTIONS
 */
async function fetchTransactions() {
    try {
        const data = await apiFetch('user/history');
        if (!data || !data.success) return [];
        return data.history || [];
    } catch (err) {
        console.error("❌ fetchTransactions sync failed:", err);
        throw err; // Throw so the UI can show an error state
    }
}

/**
 * BET PLACEMENT
 */
window.placeBet = async function(marketId, side, amount) {
    const token = localStorage.getItem("token");
    if (!token) return alert("Login required"), false;

    try {
        const data = await apiFetch('place-bet', {
            method: "POST",
            body: { marketId, side, amount }
        });

        if (data.success) {
            // 1. Update Balance instantly from the server response
            const balDisplay = document.getElementById('mainBalance');
            if (balDisplay && data.bet) {
                // Deduct locally or use server's new balance if provided
                const current = parseFloat(balDisplay.innerText);
                balDisplay.innerText = (current - amount).toFixed(2);
            }

            if (typeof refreshBets === "function") {
                await refreshBets(); 
            }
            
            window.showToast?.("🎯 Bet confirmed! Serious levels.", "#00ff88");
            window.updateNotificationBadge?.();
            return true;
        } else {
            alert(data.message || "Bet failed");
            return false;
        }

    } catch (err) {
        console.error("❌ error:", err);
        alert("Connection error. Please try again.");
        return false;
    }
};

window.showEmailEdit = function() {
    const display = document.getElementById("userEmailDisplay");
    const currentEmail = JSON.parse(localStorage.getItem("user_data") || "{}").email || "";
    display.innerHTML = `
        <div style="display:flex; align-items:center; gap:5px; background:#111; padding:4px 8px; border-radius:8px; border:1px solid #333;">
            <input type="email" id="inlineEmailInput" value="${currentEmail}" style="background:none; border:none; color:white; font-size:0.85rem; width:140px; outline:none;" autofocus>
            <span onclick="window.saveEmailInline()" style="cursor:pointer; font-size:1.1rem; filter: drop-shadow(0 0 5px #00ff88);">✔️</span>
        </div>
    `;
};

window.saveEmailInline = async function() {
    const email = document.getElementById("inlineEmailInput").value.trim();
    if (!email || !email.includes('@')) return alert("Please enter a valid email");

    try {
        const res = await apiFetch('user/update-email', {
            method: "POST",
            body: { email }
        });

        if (res.success) {
            fetchProfile();
        } else {
            alert(res.message || "Failed to update email");
        }
    } catch (err) { console.error(err); }
};

async function fetchGlobalNews() {
    try {
        // Removing leading slash so it hits /api/news/everything
        const res = await apiFetch("news/everything");
        
        // Ensure we extract the articles array and process them
        const newsData = res.articles || res || [];
        return newsData;
    } catch (err) {
        console.error("❌ fetchGlobalNews error:", err);
        return [];
    }
}


async function triggerDeposit() {
    const amount = prompt("Enter amount (sKES):");
    if (!amount) return;

    try {
        await apiFetch('stkpush', {
            method: 'POST',
            body: JSON.stringify({ amount: parseFloat(amount) })
        });

        showToast?.("📲 STK push sent!");
    } catch (e) {
        console.error("Deposit error:", e);
        showToast?.("Deposit failed", "red");
    }
}

window.processWithdraw = async function() {
    const amount = prompt("Enter amount to withdraw (min 100 sKES):");
    
    // 1. Validation
    if (!amount || amount.trim() === "") return; 
    const withdrawAmt = parseFloat(amount);
    
    if (isNaN(withdrawAmt) || withdrawAmt < 100) {
        return alert("Minimum withdrawal is 100 sKES");
    }
    
    try {
        // 2. API Call
        const response = await apiFetch('withdraw', {
            method: 'POST',
            body: JSON.stringify({ amount: withdrawAmt })
        });

        // 3. Success Feedback
        const user = JSON.parse(localStorage.getItem("user_data") || "{}");
        const phone = user.phone || "registered number";
        
        window.showToast?.(`💸 Sent to Safaricom ${phone}. SMS & Email queued! Heritage levels reached.`, "#00ff88");
        
        // 4. Update Notifications Badge (The "Dot")
        window.updateNotificationBadge?.();
        
        if (typeof fetchProfile === 'function') fetchProfile(); // Updates balance display
        if (typeof loadHistory === 'function') loadHistory();   // Refreshes the new history table
        
        if (typeof toggleAccountCenter === 'function') toggleAccountCenter();

    } catch (e) {
        console.error("Withdraw error:", e);
        if (typeof showToast === 'function') {
            const errorMsg = e.message || "Network error";
            showToast("❌ Withdraw failed: " + errorMsg, "red");
        }
    }
};
window.toggleWithdrawModal = function() {
    let modal = document.getElementById('withdrawModal');
    
    // IF THE MODAL IS MISSING, CREATE IT ON THE FLY
    if (!modal) {
        console.log("Withdraw modal missing. Creating universal instance...");
        const user = JSON.parse(localStorage.getItem("user_data") || "{}");
        const phone = user.phone || "registered number";
        const modalHtml = `
            <div id="withdrawModal" class="modal-overlay" style="display: flex; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.9); z-index: 100000; justify-content: center; align-items: center; backdrop-filter: blur(5px);">
                <div class="modal-content" style="background: #1a1b22; padding: 25px; border-radius: 16px; border: 1px solid #333; width: 90%; max-width: 350px;">
                    <div class="modal-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                        <h3 style="color:white; margin:0;">Withdraw Funds</h3>
                        <button onclick="document.getElementById('withdrawModal').style.display='none'" style="background:none; border:none; color:gray; font-size:1.5rem; cursor:pointer;">✕</button>
                    </div>
                    <div class="modal-body">
                        <p style="color: gray; font-size: 0.8rem; margin-bottom:10px;">Minimum withdrawal: 100 sKES</p>
                        <p style="color: #00ff88; font-size: 0.75rem; margin-bottom:15px; font-weight:bold;">Recipient: Safaricom M-Pesa (${phone})</p>
                        <input type="number" id="withdrawAmount" placeholder="Enter amount" style="width: 100%; background: #0b0c10; border: 1px solid #3f3f46; padding: 12px; border-radius: 8px; color: white; margin-bottom:20px;">
                        <button onclick="handleWithdrawSubmit()" style="width: 100%; background: #00ff88; color: black; border: none; padding: 12px; border-radius: 8px; font-weight: bold; cursor: pointer;">💸 Request Withdrawal</button>
                    </div>
                </div>
            </div>`;
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        return; // It's already showing now
    }

    // Standard toggle if it exists
    const isHidden = window.getComputedStyle(modal).display === 'none';
    modal.style.display = isHidden ? 'flex' : 'none';
};

window.handleWithdrawSubmit = async function() {
    const amountInput = document.getElementById('withdrawAmount');
    const amount = parseFloat(amountInput.value);

    if (!amount || amount < 100) {
        alert("Please enter an amount of at least 100 sKES");
        return;
    }

    try {
        const result = await apiFetch('withdraw', {
            method: 'POST',
            body: { amount: amount }
        });
        
        if (result.success) {
            const user = JSON.parse(localStorage.getItem("user_data") || "{}");
            const phone = user.phone || "registered number";
            
            window.showToast?.(`💸 Funds sent to ${phone}. SMS & Email dispatched. Clinical.`, "#00ff88");
            window.updateNotificationBadge?.();
            toggleWithdrawModal(); 
            if (window.fetchProfile) window.fetchProfile(); 
        } else {
            alert(result.message || "Failed to process withdrawal");
        }
    } catch (err) {
        console.error("Withdrawal Error:", err);
        alert("Server error. Please try again later.");
    }
};
window.triggerDeposit = function() {
    let modal = document.getElementById('depositModal');
    
    // Auto-create if missing in DOM
    if (!modal) {
        console.log("Deposit modal missing. Creating universal instance...");
        const modalHtml = `
            <div id="depositModal" class="modal-overlay" style="display: flex; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.9); z-index: 100001; justify-content: center; align-items: center; backdrop-filter: blur(5px);">
                <div class="modal-content" style="background: #1a1b22; padding: 25px; border-radius: 16px; border: 1px solid #333; width: 90%; max-width: 380px; position: relative;">
                    <div class="modal-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                        <h3 style="color:white; margin:0;">Deposit Funds</h3>
                        <button onclick="document.getElementById('depositModal').style.display='none'" style="background:none; border:none; color:gray; font-size:1.5rem; cursor:pointer;">✕</button>
                    </div>
                    <div class="modal-body" style="text-align: center;">
                        <p style="color: #00ff88; font-size: 0.85rem; margin-bottom:15px; font-weight:bold;">Instant M-PESA Deposit</p>
                        
                        <div style="text-align: left; margin-bottom: 20px;">
                            <label style="color: #888; font-size: 0.75rem; display: block; margin-bottom: 5px;">AMOUNT (sKES)</label>
                            <input type="number" id="depositAmount" placeholder="Min 1 KES" style="width: 100%; background: #000; border: 1px solid #444; padding: 15px; border-radius: 8px; color: white; font-size: 1.2rem; font-weight: bold;">
                        </div>

                                        <button onclick="handleDepositSubmit()" style="width: 100%; background: #00ff88; color: black; border: none; padding: 15px; border-radius: 10px; font-weight: bold; cursor: pointer; font-size: 1rem;">
                            💰 Deposit Now
                        </button>
                        <button onclick="openCryptoDeposit()" style="width: 100%; margin-top:10px; background: #111; color: #00ff88; border: 1px solid #00ff88; padding: 12px; border-radius: 10px; font-weight: 700; cursor: pointer; font-size: 0.95rem;">
                            Deposit from Crypto
                        </button>
                        
                        <p style="color: #555; font-size: 0.7rem; margin-top: 15px;">
                            By clicking Deposit, you will receive an STK Push on your registered M-PESA number.
                        </p>
                    </div>
                </div>
            </div>`;
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        return;
    }

    modal.style.display = 'flex';
};
window.handleDepositSubmit = async function() {
    const amountInput = document.getElementById('depositAmount');
    const amount = parseFloat(amountInput.value);

    if (!amount || amount < 1) {
        alert("Minimum deposit is 1 sKES");
        return;
    }

    // Change button state to loading
    const btn = event.target;
    const originalText = btn.innerText;
    btn.innerText = "Processing...";
    btn.disabled = true;

    try {
        const result = await apiFetch('stkpush', {
            method: 'POST',
            body: { amount: amount }
        });

        if (result.success) {
            window.showToast?.("📲 STK Push sent! Confirm on phone. Baller move.", "#00ff88");
            window.updateNotificationBadge?.();
            document.getElementById('depositModal').style.display = 'none';
        } else {
            alert(result.message || "Deposit request failed");
        }
    } catch (err) {
        console.error("Deposit Error:", err);
        alert("Connection error. Please try again.");
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
};
async function refreshBalance() {
    const data = await apiFetch('user/sync-wallet');
    if (data.success) {
        document.getElementById('userBalance').innerText = data.balance;
        alert("Balance synced with Blockchain!");
    }
}
window.API = {
    login,
    register,
    fetchProfile,
    fetchTransactions,
    updateEmail,
    upgradeAccount,
    updateProfile,
    placeBet: window.placeBet,
    fetchMpesaLog,
    fetchGlobalNews,
    triggerDeposit,
    processWithdraw: window.processWithdraw,
    refreshBalance,
    resetPassword,
    adminCreateMarket,
    depositCrypto,
    deleteNotification,
    markNotificationsRead: window.markNotificationsRead
};
window.API.apiFetch = apiFetch;
window.apiFetch = apiFetch;
window.API.apiFetch = apiFetch;
window.apiFetch = apiFetch;
