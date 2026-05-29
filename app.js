
let socket;
let bettingLock = false;
let currentHistoryTab = "active";

let cachedMarkets = JSON.parse(
    localStorage.getItem("cached_markets") || "[]"
);

window.onload = async () => {
    const token = localStorage.getItem("token");
    if (!token) {
        window.location.href = "login.html";
        return;
    }

    try {
        if (typeof loadModules === "function") await loadModules();
        if (typeof activateModules === "function") activateModules();
        if (typeof initAvatarUpload === "function") initAvatarUpload();

        const profile = await fetchProfile();
        initSocket();
        renderBalanceDisplay(); // Initial render of the balance card

        // If this user is the configured SuperAdmin, simplify the sidebar to theme only and add Admin entry
        try {
            const adminStats = await apiFetch('admin/stats');
            if (adminStats && adminStats.isSuperAdmin) {
                const mainSidebar = document.getElementById('mainSidebar');
                if (mainSidebar) {
                    // Remove Markets section buttons
                    const labels = mainSidebar.querySelectorAll('.section-label');
                    labels.forEach(l => { if (l.innerText.trim().toLowerCase() === 'markets') l.remove(); });
                    const btnGroups = mainSidebar.querySelectorAll('.sidebar-buttons');
                    btnGroups.forEach((g, idx) => {
                        // Keep the second group (Account) but remove the first (markets)
                        if (idx === 0) g.remove();
                    });

                    // Insert SuperAdmin entry at top
                    const adminBtn = document.createElement('div');
                    adminBtn.className = 'section-label';
                    adminBtn.style.marginTop = '8px';
                    adminBtn.innerHTML = `<div style="margin-bottom:8px; font-weight:bold; color:#00ff88;">SuperAdmin</div>`;
                    mainSidebar.insertBefore(adminBtn, mainSidebar.firstChild);

                    const adminEntry = document.createElement('div');
                    adminEntry.className = 'sidebar-buttons';
                    adminEntry.innerHTML = `<button class="sidebar-btn" id="openAdminConsole">👑 Admin Console</button>`;
                    mainSidebar.insertBefore(adminEntry, adminBtn.nextSibling);

                    document.getElementById('openAdminConsole')?.addEventListener('click', () => { window.openAdminPanel ? window.openAdminPanel() : window.location.href = 'admin.html'; });
                }
            }
        } catch (e) { /* ignore */ }

        const response = await fetchMarkets().catch(e => console.warn("Initial sync limited:", e.message));

        if (response && Array.isArray(response.markets)) {
            const markets = response.markets;

            // IMPORTANT: store master copy
            window.allMarketsSource = markets;
            state.allMarkets = markets;

            // default view = all markets
            state.filteredMarkets = markets;

            console.log("ALL MARKETS:", markets.length);

        } else {
            console.error("Invalid markets response");
        }

        if (typeof window.setCategory === "function") {
            window.setCategory(window.state.category);
        }

        const lastMarketId = localStorage.getItem("last_market_id");
        if (lastMarketId) {
            // Small delay to ensure market map is synced before opening
            setTimeout(() => { if (typeof openMarket === 'function') openMarket(lastMarketId); }, 300);
        }

        // Merge server-provided news markets (from /news/everything) into state
        try {
            if (typeof fetchGlobalNews === 'function') {
                const remoteNews = await fetchGlobalNews();
                if (Array.isArray(remoteNews) && remoteNews.length) {
                    const existingIds = new Set((state.allMarkets || []).map(m => m.id));
                    const toAdd = [];
                    for (const n of remoteNews) {
                        if (!n || !n.id) continue;
                        if (!existingIds.has(n.id)) {
                            existingIds.add(n.id);
                            toAdd.push(n);
                        }
                    }
                    if (toAdd.length) {
                        state.allMarkets = [...toAdd, ...(state.allMarkets || [])];
                        state.filteredMarkets = state.allMarkets;
                        window.allMarketsSource = state.allMarkets;
                        if (typeof syncMarketMap === 'function') syncMarketMap(state.allMarkets);
                        renderFilteredMarkets();
                        renderTrending();
                    }
                }
            }
        } catch (e) { console.warn('news merge failed', e.message); }
    } catch (err) {
        console.error("Dashboard init error:", err);
    }
};

/**
 * MODULE LOADING
 */
async function loadModules() {
    const modules = [
        { id: "sidebar-placeholder", file: "sidebar.html" },
        { id: "profile-placeholder", file: "profile.html" },
        { id: "history-placeholder", file: "history.html" },
        { id: "markets-ui-placeholder", file: "markets-ui.html" }
    ];

    for (const mod of modules) {
        try {
            const res = await fetch(`./modules/${mod.file}`);
            const html = await res.text();
            const el = document.getElementById(mod.id);
            if (el) el.innerHTML = html;
        } catch (err) {
            console.error("Module load failed:", mod.file, err);
        }
    }
}

/**
 * SOCKET
 */
function initSocket() {
    const token = localStorage.getItem("token");
    if (!token) return;
    if (!window.API_BASE || typeof io !== "function") {
        console.warn("Socket skipped until the backend URL is configured.");
        return;
    }

    // Fix: Connect socket to the API_BASE (Backend) not the GitHub frontend
    socket = io(window.API_BASE, {
        auth: { token },
        transports: ["websocket"]
    });

    socket.on("connect", () => {
        console.log("✅ Socket connected");
        socket.emit("requestInitialData");

        // Join admin room if authorized
        const savedUser = JSON.parse(localStorage.getItem("user_data") || "{}");
        if (savedUser.role === 'admin') {
            socket.emit("adminJoin");
        }
    });

    socket.on("connect_error", (err) => {
        console.error("❌ Socket Connection Error:", err.message);
        showToast("Real-time connection failed. Retrying...", "orange");
    });

    socket.on("mpesaLogUpdate", (data) => {
        const logContainer = document.getElementById('mpesa-log-view');
        if (logContainer && typeof window.openMpesaDashboard === 'function') {
            window.openMpesaDashboard(); // Refresh current view
        }
        
        showToast(`M-Pesa: ${data.status} for ${data.phone || 'Unknown'}`);
    });

    socket.on("marketsUpdated", (payload) => {
        if (!payload?.markets) return;

        const processed = payload.markets || [];

        window.state.allMarkets = processed;
        window.allMarketsSource = processed;
        if (typeof syncMarketMap === "function") syncMarketMap(processed);
        applyStateAndRender();
    });

    socket.on("match_update", (update) => {
        updateMatchRealtime?.(update);
    });

    socket.on("balanceUpdate", (data) => {
        if (data?.balance !== undefined) {
            renderBalanceDisplay(); // Re-render the balance card on update
        }
    });

    socket.on("betPlaced", (newBet) => {
        console.log("New bet confirmed:", newBet);

        const activeSubTab = document.querySelector('.predictions-nav .sub-tab.active');
        if (activeSubTab && activeSubTab.innerText.trim().toLowerCase() === 'active') {
            window.refreshBets('active');
        }
        fetchProfile?.();
    });

    socket.on("newNotification", (data) => {
        showToast(`🔔 ${data.title}: ${data.message}`);
        updateNotificationBadge();
    });
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"'`]/g, (s) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;','`':'&#96;'})[s]);
}

// Function to render the balance card in the main dashboard
function renderBalanceDisplay() {
    let balanceCardContainer = document.getElementById('balanceCardInstance');
    if (!balanceCardContainer) {
        const topRow = document.getElementById('balAdminRow');
        if (topRow) {
            const newBalanceCard = document.createElement('div');
            newBalanceCard.id = 'balanceCardInstance';
            newBalanceCard.className = 'balance-card-dark';
            newBalanceCard.style.flex = "1";
            topRow.prepend(newBalanceCard);
            balanceCardContainer = newBalanceCard; // Update reference
        } else {
            console.warn("Could not find .top-dashboard-row to render balance card.");
            return;
        }
    }

    const user = JSON.parse(localStorage.getItem("user_data") || "{}");
    const balance = user.balance || 0;

    if (typeof window.renderBalanceCard === 'function') {
        balanceCardContainer.innerHTML = window.renderBalanceCard(balance);
    }
}

/**
 * UPGRADE FLOW 🚀
 */
window.startUpgradeFlow = function() {
    const modalHtml = `
        <div id="upgradeModal" class="modal-overlay" style="display: flex; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.95); z-index: 100002; justify-content: center; align-items: center; backdrop-filter: blur(10px);">
            <div class="modal-content" style="background: #0b0c10; padding: 30px; border-radius: 20px; border: 1px solid #00ff88; width: 90%; max-width: 400px; text-align: center; box-shadow: 0 0 30px rgba(0,255,136,0.2);">
                <h2 style="color: #00ff88; margin-bottom: 15px;">Elite Upgrade</h2>
                <p style="color: #ccc; font-size: 0.9rem; line-height: 1.6; margin-bottom: 20px;">
                    Unlock the <strong>Elite Package</strong> for 2 months. 
                    Enjoy 10% boosted odds, priority withdrawal processing, and exclusive daily market insights. 
                    <br><br>
                    <span style="font-size: 1.2rem; color: white; font-weight: 800;">Cost: 1,500 sKES</span>
                </p>
                <button onclick="window.showUpgradeTerms()" style="width: 100%; background: #00ff88; color: black; border: none; padding: 15px; border-radius: 10px; font-weight: 800; cursor: pointer;">Interested? Yes!</button>
                <button onclick="document.getElementById('upgradeModal').remove()" style="background: none; border: none; color: gray; margin-top: 15px; cursor: pointer;">Maybe Later</button>
            </div>
        </div>`;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
};

window.openAdminPanel = async function() {
        const sanitize = (text) => String(text || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
        let statsHtml = '';
        try {
            const res = await apiFetch('admin/stats'); 
            if (res && res.success) {
                statsHtml = `
                    <div style="display:grid; grid-template-columns: repeat(2, 1fr); gap:10px; margin-bottom:20px; background:#000; padding:15px; border-radius:12px; border:1px solid #333;">
                        ${res.remainingDays !== undefined ? `
                            <div style="background:#111; padding:10px; border-radius:8px; position:relative;">
                                <div style="color:#888; font-size:0.6rem;">MY SUBSCRIPTION</div>
                                <div style="color:#00ff88; font-weight:800;">${res.remainingDays} Days Left</div>
                                ${res.remainingDays <= 7 ? `<button onclick="window.startUpgradeFlow()" style="margin-top:5px; background:#ffaa00; border:none; padding:4px 8px; border-radius:4px; font-size:0.6rem; font-weight:bold; cursor:pointer;">RENEW NOW ⚡</button>` : ''}
                            </div>` : ''}
                        ${res.profit !== undefined ? `<div style="background:#111; padding:10px; border-radius:8px;"><div style="color:#888; font-size:0.6rem;">PLATFORM PROFIT</div><div style="color:#00ff88; font-weight:800;">sKES ${Number(res.profit).toFixed(0)}</div></div>` : ''}
                        ${res.bonuses !== undefined ? `<div style="background:#111; padding:10px; border-radius:8px;"><div style="color:#888; font-size:0.6rem;">TOTAL BONUSES</div><div style="color:white; font-weight:800;">sKES ${res.bonuses}</div></div>` : ''}
                        ${res.subscriptions !== undefined ? `<div style="background:#111; padding:10px; border-radius:8px;"><div style="color:#888; font-size:0.6rem;">ELITE USERS</div><div style="color:white; font-weight:800;">${res.subscriptions} Active</div></div>` : ''}
                    </div>
                    ${res.isSuperAdmin ? `<button onclick="window.showUserManagement()" style="width:100%; margin-bottom:15px; background:#00ff88; color:black; border:none; padding:12px; border-radius:10px; font-size:0.8rem; font-weight:bold; cursor:pointer;">👥 MANAGE ALL USERS</button>` : ''}
                    ${res.isSuperAdmin ? `<button onclick="window.openAdminMarketEditor()" style="width:100%; margin-bottom:15px; background:#00d1ff; color:black; border:none; padding:12px; border-radius:10px; font-size:0.8rem; font-weight:bold; cursor:pointer;">✍️ EDIT / REPHRASE MARKETS</button>` : ''}
                `;

                if (res.boostedMarkets && res.boostedMarkets.length > 0) {
                    statsHtml += `
                        <div style="margin-bottom:20px; background:#020b10; border:1px solid #113322; border-radius:12px; padding:15px;">
                            <div style="color:#00ff88; font-size:0.75rem; font-weight:800; margin-bottom:10px;">⭐ Today's Elite Boosted Markets</div>
                            ${res.boostedMarkets.map(m => `
                                <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; margin-bottom:10px; padding:10px; background:#08100f; border-radius:10px;">
                                    <div style="flex:1; color:#ddd; font-size:0.82rem; line-height:1.3;">${sanitize(m.title)}</div>
                                    <div style="text-align:right; color:#00ff88; font-size:0.82rem; font-weight:800;">YES ${Number(m.oddsA || 1.9).toFixed(2)} / NO ${Number(m.oddsB || 1.9).toFixed(2)}</div>
                                </div>
                            `).join('')}
                        </div>
                    `;
                }

                // If Super Admin, show Pending Approvals
                if (res.pendingMarkets && res.pendingMarkets.length > 0) {
                    statsHtml += `
                        <div style="margin-bottom:20px;">
                            <h4 style="color:#ffaa00; font-size:0.7rem; margin-bottom:10px;">PENDING APPROVALS</h4>
                            <div style="max-height:150px; overflow-y:auto; border:1px solid #222; border-radius:8px; background:#000;">
                                ${res.pendingMarkets.map(m => `
                                    <div style="padding:10px; border-bottom:1px solid #222; display:flex; justify-content:space-between; align-items:center;">
                                        <div style="font-size:0.75rem; color:white;">${sanitize(m.title)} <br><small style="color:#555">by ${sanitize(m.creator_name || m.creator)}</small></div>
                                        <div style="display:flex; gap:5px;">
                                            <button onclick="approveMarket('${m.id}')" style="background:#00ff88; color:black; border:none; padding:4px 8px; border-radius:4px; font-size:0.65rem; font-weight:bold; cursor:pointer;">Approve</button>
                                            <button onclick="rejectMarket('${m.id}')" style="background:#ff4444; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:0.65rem; font-weight:bold; cursor:pointer;">Reject</button>
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    `;
                }
            }
        } catch(e) {
            console.warn("Could not load admin stats", e);
        }

        const modalHtml = `
        <div id="adminModal" class="modal-overlay" style="display:flex; position:fixed; inset:0; background:rgba(0,0,0,0.9); justify-content:center; align-items:center; z-index:100005;">
            <div class="modal-content" style="width:95%; max-width:500px; background:#1a1b23; padding:25px; border-radius:16px; border:1px solid #333;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                    <h2 style="color:#00ff88; margin:0;">Admin Control</h2>
                    <span style="color:#555; font-size:0.7rem;">Soko ni Soko</span>
                </div>
                ${statsHtml}
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:10px;">
                    <div style="grid-column: 1 / -1;">
                        <label style="color:#888; font-size:0.7rem;">MARKET QUESTION</label>
                        <input id="adminMarketTitle" placeholder="e.g. Will Arsenal win?" style="width:100%; padding:12px; background:#000; border:1px solid #333; color:white; border-radius:8px; margin-top:5px;" />
                    </div>
                    <div>
                        <label style="color:#888; font-size:0.7rem;">CATEGORY</label>
                        <select id="adminMarketCategory" style="width:100%; padding:12px; background:#000; border:1px solid #333; color:white; border-radius:8px; margin-top:5px;">
                            <option value="football">Football</option>
                            <option value="crypto">Crypto</option>
                            <option value="politics">Politics</option>
                            <option value="news">News</option>
                            <option value="tech">Tech</option>
                            <option value="misc">Miscellaneous</option>
                        </select>
                    </div>
                    <div>
                        <label style="color:#888; font-size:0.7rem;">CLOSE BETTING AT</label>
                        <input id="adminMarketStart" type="datetime-local" style="width:100%; padding:12px; background:#000; border:1px solid #333; color:white; border-radius:8px; margin-top:5px;" />
                    </div>
                    <div style="grid-column: 1 / -1;">
                        <label style="color:#888; font-size:0.7rem;">MEDIA URL (Image, Video, YouTube)</label>
                        <input id="adminMarketMedia" placeholder="https://..." style="width:100%; padding:12px; background:#000; border:1px solid #333; color:white; border-radius:8px; margin-top:5px;" />
                    </div>
                    <div style="grid-column: 1 / -1;">
                        <label style="color:#888; font-size:0.7rem;">MEDIA TYPE</label>
                        <select id="adminMarketMediaType" style="width:100%; padding:12px; background:#000; border:1px solid #333; color:white; border-radius:8px; margin-top:5px;">
                            <option value="auto">Auto Detect</option>
                            <option value="image">Image</option>
                            <option value="video">Video</option>
                            <option value="youtube">YouTube</option>
                        </select>
                    </div>
                    <div style="display:flex; gap:10px; grid-column: 1 / -1;">
                        <input id="adminMarketSideA" placeholder="Side A (e.g. YES)" style="flex:1; padding:12px; background:#000; border:1px solid #333; color:white; border-radius:8px;" />
                        <input id="adminMarketSideB" placeholder="Side B (e.g. NO)" style="flex:1; padding:12px; background:#000; border:1px solid #333; color:white; border-radius:8px;" />
                    </div>
                    <textarea id="adminMarketDesc" placeholder="Rules/Context..." style="padding:12px; background:#000; border:1px solid #333; color:white; grid-column:1 / -1; border-radius:8px; height:80px;"></textarea>
                </div>
                <div style="display:flex; gap:10px; margin-top:15px;">
                    <button onclick="submitAdminMarket()" style="flex:1; background:#00ff88; color:black; padding:12px; border-radius:8px; font-weight:800;">Submit</button>
                    <button onclick="document.getElementById('adminModal').remove()" style="flex:1; background:#333; color:white; padding:12px; border-radius:8px;">Cancel</button>
                </div>
            </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', modalHtml);
};

window.showUserManagement = async function() {
    const res = await apiFetch('admin/users');
    if (!res?.success) return alert("Unauthorized");

    const usersHtml = res.users.map(u => `
        <div style="padding:12px; border-bottom:1px solid #222; display:flex; justify-content:space-between; align-items:center;">
            <div onclick="window.viewUserDetails('${u.phone}')" style="cursor:pointer; flex:1;">
                <div style="color:white; font-size:0.85rem; font-weight:bold;">${u.name || 'No Name'} ${u.is_upgraded ? '💎' : ''}</div>
                <div style="color:#666; font-size:0.7rem;">${u.phone} • Bal: ${u.balance} sKES</div>
                <div style="font-size:0.6rem; margin-top:4px; font-weight:bold; color:${u.is_suspended ? '#ff4444' : '#00ff88'}; text-transform:uppercase;">● ${u.is_suspended ? 'Suspended' : 'Active'}</div>
            </div>
            <div style="display:flex; gap:5px;">
                <button onclick="manageUserAction('${u.phone}', 'suspend')" style="background:${u.is_suspended ? '#00ff88' : '#333'}; border:none; padding:5px 8px; border-radius:5px; font-size:0.65rem; color:${u.is_suspended ? 'black' : 'white'}; cursor:pointer;">${u.is_suspended ? 'Unsuspend' : 'Suspend'}</button>
                ${u.is_upgraded ? `<button onclick="manageUserAction('${u.phone}', 'revoke')" style="background:#ffaa00; border:none; padding:5px 8px; border-radius:5px; font-size:0.65rem; color:black; cursor:pointer;">Revoke</button>` : ''}
                <button onclick="manageUserAction('${u.phone}', 'delete')" style="background:#ff4444; border:none; padding:5px 8px; border-radius:5px; font-size:0.65rem; color:white; cursor:pointer;">Delete</button>
            </div>
        </div>
    `).join('');

    const modalHtml = `
        <div id="userManageModal" style="position:fixed; inset:0; background:rgba(0,0,0,0.9); z-index:100006; display:flex; justify-content:center; align-items:center;">
            <div style="background:#1a1b23; width:95%; max-width:500px; height:80vh; padding:25px; border-radius:16px; border:1px solid #333; display:flex; flex-direction:column;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                    <h3 style="color:#00ff88; margin:0;">User Directory</h3>
                    <button onclick="document.getElementById('userManageModal').remove()" style="background:none; border:none; color:gray; font-size:1.5rem; cursor:pointer;">✕</button>
                </div>
                <div style="flex:1; overflow-y:auto; background:#000; border-radius:10px; border:1px solid #222;">
                    ${usersHtml || '<div style="padding:20px; text-align:center; color:#555;">No users found.</div>'}
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
};

window.manageUserAction = async function(phone, action) {
    if (action === 'delete' && !confirm(`⚠️ WARNING: Permanently delete user ${phone}? This cannot be undone.`)) return;
    
    const reason = prompt(`Enter reason for ${action} (User will see this in the email):`);
    if (!reason) return alert("Action cancelled. A reason is required for the audit trail.");

    try {
        const res = await apiFetch('admin/users/manage', { method: 'POST', body: { phone, action, reason } });
        if (res.success) {
            showToast(`User ${action} success`);
            document.getElementById('userManageModal').remove();
            window.showUserManagement();
        }
    } catch(e) { alert("Action failed"); }
};

window.viewUserDetails = async function(phone) {
    try {
        const res = await apiFetch(`admin/users/${phone}/details`);
        if (!res?.success) return;
        const { user, stats } = res;
        
        const detailHtml = `
            <div id="userDetailModal" style="position:fixed; inset:0; background:rgba(0,0,0,0.95); z-index:100007; display:flex; justify-content:center; align-items:center;">
                <div style="background:#0b0c10; width:90%; max-width:350px; padding:30px; border-radius:20px; border:1px solid #444; text-align:center;">
                    <div style="width:60px; height:60px; background:#00ff88; border-radius:50%; display:flex; align-items:center; justify-content:center; margin:0 auto 15px auto; font-size:1.5rem; color:black; font-weight:bold;">${user.name?.[0] || 'U'}</div>
                    <h3 style="color:white; margin:0;">${user.name}</h3>
                    <p style="color:#888; font-size:0.8rem; margin:5px 0 20px 0;">${user.phone} • ${user.email}</p>
                    
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:20px;">
                        <div style="background:#1a1b23; padding:10px; border-radius:10px;">
                            <div style="font-size:0.6rem; color:#666;">BALANCE</div>
                            <div style="color:#00ff88; font-weight:bold;">${user.balance}</div>
                        </div>
                        <div style="background:#1a1b23; padding:10px; border-radius:10px;">
                            <div style="font-size:0.6rem; color:#666;">BETS</div>
                            <div style="color:white; font-weight:bold;">${stats.totalBets}</div>
                        </div>
                        <div style="background:#1a1b23; padding:10px; border-radius:10px;">
                            <div style="font-size:0.6rem; color:#666;">DEPOSITS</div>
                            <div style="color:#00ff88; font-weight:bold;">${stats.deposits || 0}</div>
                        </div>
                        <div style="background:#1a1b23; padding:10px; border-radius:10px;">
                            <div style="font-size:0.6rem; color:#666;">WITHDRAWS</div>
                            <div style="color:#ff4444; font-weight:bold;">${stats.withdrawals || 0}</div>
                        </div>
                    </div>
                    <button onclick="document.getElementById('userDetailModal').remove()" style="width:100%; background:#333; border:none; color:white; padding:12px; border-radius:10px; cursor:pointer;">Back to List</button>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', detailHtml);
    } catch(e) { alert("Could not load details"); }
};

window.adminRewardReferral = async function() {
    const phone = document.getElementById('adminRefPhone').value.trim();
    if (!phone) return alert("Enter phone number");
    
    try {
        const res = await apiFetch('admin/reward-referral', {
            method: 'POST',
            body: { phone }
        });
        if (res.success) { 
            showToast("Referral Bonus of 100 KES Sent!");
            document.getElementById('adminRefPhone').value = '';
        } else {
            alert(res.message || "Reward failed");
        }
    } catch(e) { alert("Network error"); }
};

window.approveMarket = async function(marketId) {
    try {
        const res = await apiFetch('admin/approve-market', { method: 'POST', body: { marketId } });
        if (res.success) {
            showToast("Market Approved & Creator Notified");
            document.getElementById('adminModal').remove();
            window.openAdminPanel();
        }
    } catch(e) { alert("Approval failed"); }
};

window.rejectMarket = async function(marketId) {
    try {
        const res = await apiFetch('admin/reject-market', { method: 'POST', body: { marketId } });
        if (res.success) {
            showToast("Market Rejected", "red");
            document.getElementById('adminModal').remove();
            window.openAdminPanel();
        }
    } catch(e) { alert("Rejection failed"); }
};

window.openAdminMarketEditor = async function() {
    try {
        const res = await apiFetch('admin/all-markets');
        if (!res?.success) return alert('Unable to load markets for editing.');

        const marketsHtml = res.markets.map(m => `
            <div style="padding:12px; border-bottom:1px solid #222; display:flex; justify-content:space-between; align-items:center; gap:10px;">
                <div style="flex:1; min-width:0;">
                    <div style="color:#fff; font-size:0.9rem; font-weight:700;">${m.title || '(untitled market)'}</div>
                    <div style="color:#888; font-size:0.75rem; margin-top:4px;">${(m.category || 'general').toUpperCase()} • ${m.status || 'unknown'}</div>
                </div>
                <button onclick="window.openMarketEditModal('${m.id}')" style="background:#00d1ff; color:black; border:none; padding:8px 12px; border-radius:8px; font-size:0.75rem; font-weight:800; cursor:pointer;">Edit</button>
            </div>
        `).join('');

        const modalHtml = `
            <div id="marketEditorModal" style="position:fixed; inset:0; background:rgba(0,0,0,0.9); z-index:100008; display:flex; justify-content:center; align-items:center; padding:20px;">
                <div style="background:#111; width:100%; max-width:760px; max-height:90vh; overflow-y:auto; border-radius:18px; border:1px solid #333; padding:20px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:18px; gap:10px;">
                        <div>
                            <h3 style="color:#00ff88; margin:0;">SuperAdmin Market Editor</h3>
                            <p style="color:#888; font-size:0.85rem; margin:4px 0 0 0;">Select a market and use AI to sharpen the question and description.</p>
                        </div>
                        <button onclick="document.getElementById('marketEditorModal').remove()" style="background:none; border:none; color:#fff; font-size:1.4rem; cursor:pointer;">✕</button>
                    </div>
                    <div style="background:#0e1116; border:1px solid #222; border-radius:14px; padding:14px; margin-bottom:18px; color:#bbb; font-size:0.85rem;">Tip: Click Edit and then use Rephrase to update the title and content quickly. Choose GPT or Gemini if your environment supports it.</div>
                    <div style="display:grid; grid-template-columns:1fr; gap:10px;">
                        ${marketsHtml}
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHtml);
    } catch (e) {
        console.error('Market editor load failed:', e);
        alert('Unable to open market editor.');
    }
};

window.openMarketEditModal = async function(marketId) {
    try {
        const res = await apiFetch('admin/all-markets');
        if (!res?.success) return alert('Unable to fetch market details.');
        const market = res.markets.find(m => m.id === marketId);
        if (!market) return alert('Market not found.');

        const modalHtml = `
            <div id="marketRephraseModal" style="position:fixed; inset:0; background:rgba(0,0,0,0.95); z-index:100009; display:flex; justify-content:center; align-items:center; padding:20px;">
                <div style="background:#111; width:100%; max-width:720px; max-height:92vh; overflow-y:auto; border-radius:18px; border:1px solid #333; padding:22px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:18px; gap:10px;">
                        <div>
                            <h3 style="color:#00ff88; margin:0;">Edit Market</h3>
                            <p style="color:#888; font-size:0.85rem; margin:4px 0 0 0;">Use AI to rephrase the market listing before updating it live.</p>
                        </div>
                        <button onclick="document.getElementById('marketRephraseModal').remove()" style="background:none; border:none; color:#fff; font-size:1.4rem; cursor:pointer;">✕</button>
                    </div>
                    <div style="display:grid; gap:12px;">
                        <label style="color:#888; font-size:0.8rem;">Market ID</label>
                        <div style="background:#000; border:1px solid #222; border-radius:10px; padding:12px; color:#fff;">${market.id}</div>
                        <label style="color:#888; font-size:0.8rem;">Title</label>
                        <input id="marketEditTitle" value="${market.title || ''}" style="width:100%; padding:12px; border-radius:10px; border:1px solid #222; background:#000; color:#fff;" />
                        <label style="color:#888; font-size:0.8rem;">Description / Content</label>
                        <textarea id="marketEditContent" rows="6" style="width:100%; padding:12px; border-radius:10px; border:1px solid #222; background:#000; color:#fff;">${market.content || market.description || ''}</textarea>
                        <label style="color:#888; font-size:0.8rem;">Rephrase Engine</label>
                        <select id="marketRephraseEngine" style="width:100%; padding:12px; border-radius:10px; border:1px solid #222; background:#000; color:#fff;">
                            <option value="gpt">GPT</option>
                            <option value="gemini">Gemini</option>
                        </select>
                        <div style="display:flex; gap:10px; flex-wrap:wrap;">
                            <button onclick="window.rephraseMarketText('${market.id}')" style="flex:1; min-width:160px; background:#00d1ff; color:black; border:none; padding:12px; border-radius:10px; font-weight:800; cursor:pointer;">Rephrase with AI</button>
                            <button onclick="window.saveMarketEdits('${market.id}')" style="flex:1; min-width:160px; background:#00ff88; color:black; border:none; padding:12px; border-radius:10px; font-weight:800; cursor:pointer;">Save Changes</button>
                        </div>
                        <div id="marketRephraseStatus" style="color:#ccc; font-size:0.85rem; min-height:1.4rem;"></div>
                    </div>
                </div>
            </div>
        `;

        document.getElementById('marketRephraseModal')?.remove();
        document.body.insertAdjacentHTML('beforeend', modalHtml);
    } catch (e) {
        console.error('Open market edit modal failed:', e);
        alert('Unable to open edit modal.');
    }
};

window.rephraseMarketText = async function(marketId) {
    const title = document.getElementById('marketEditTitle')?.value || '';
    const content = document.getElementById('marketEditContent')?.value || '';
    const engine = document.getElementById('marketRephraseEngine')?.value || 'gpt';
    const statusEl = document.getElementById('marketRephraseStatus');
    if (!title && !content) return alert('Provide a title or description first.');

    statusEl.innerText = 'Rephrasing with AI...';
    try {
        const result = await apiFetch('admin/rephrase-market', {
            method: 'POST',
            body: { title, content, engine }
        });
        if (!result?.success) {
            statusEl.innerText = result?.message || 'Rephrase failed.';
            return;
        }

        document.getElementById('marketEditTitle').value = result.rephrased?.title || title;
        document.getElementById('marketEditContent').value = result.rephrased?.description || content;
        statusEl.innerText = `Rephrased using ${result.engine || engine}. Review and save.`;
    } catch (err) {
        console.error(err);
        statusEl.innerText = 'AI rephrase failed. Check the console.';
    }
};

window.saveMarketEdits = async function(marketId) {
    const title = document.getElementById('marketEditTitle')?.value.trim();
    const content = document.getElementById('marketEditContent')?.value.trim();
    const statusEl = document.getElementById('marketRephraseStatus');

    if (!title) return alert('Title is required.');

    statusEl.innerText = 'Saving changes...';
    try {
        const res = await apiFetch('admin/update-market', {
            method: 'POST',
            body: { id: marketId, title, content, media_url: null, media_type: 'auto' }
        });
        if (!res?.success) {
            statusEl.innerText = res?.message || 'Save failed.';
            return;
        }
        statusEl.innerText = 'Market updated successfully.';
        showToast('Market saved successfully');
        document.getElementById('marketRephraseModal')?.remove();
        document.getElementById('marketEditorModal')?.remove();
        window.openAdminPanel();
    } catch (err) {
        console.error(err);
        statusEl.innerText = 'Save failed. Check console.';
    }
};

window.submitAdminMarket = async function() {
        const btn = document.querySelector('#adminModal button');
        const title = document.getElementById('adminMarketTitle').value.trim();
        const category = document.getElementById('adminMarketCategory').value.trim() || 'misc';
        const media_url = document.getElementById('adminMarketMedia').value.trim() || null;
        const media_type = document.getElementById('adminMarketMediaType')?.value || 'auto';
        const sideA = document.getElementById('adminMarketSideA').value.trim() || 'YES';
        const sideB = document.getElementById('adminMarketSideB').value.trim() || 'NO';
        const startTime = document.getElementById('adminMarketStart').value.trim() || new Date().toISOString();
        const description = document.getElementById('adminMarketDesc').value.trim();

        if (!title) return alert('Title is required');
        
        const userData = JSON.parse(localStorage.getItem("user_data") || "{}");
        const endpoint = userData.role === 'admin' ? 'admin/create-market' : 'user/submit-market';

        try {
                btn.disabled = true;
                const res = await apiFetch(endpoint, { method: 'POST', body: { title, category, sideA, sideB, startTime, description, media_url, media_type } });
                if (res && res.success) {
                        alert('Market submitted for review. Admin will be notified.');
                        document.getElementById('adminModal').remove();
                } else {
                        alert(res?.message || 'Submission failed');
                        btn.disabled = false;
                }
        } catch (e) {
                console.error(e);
                alert('Network error');
                btn.disabled = false;
        }
};

// Deposit from Crypto Wallet modal
window.openCryptoDeposit = function() {
        const modalHtml = `
        <div id="cryptoDepositModal" class="modal-overlay" style="display:flex; position:fixed; inset:0; background:rgba(0,0,0,0.9); justify-content:center; align-items:center; z-index:100005;">
            <div class="modal-content" style="width:90%; max-width:520px; background:#0b0c10; padding:20px; border-radius:12px; border:1px solid #222;">
                <h2 style="color:#00ff88;">Deposit from Crypto Wallet</h2>
                <p style="color:#ccc;">Send your crypto to the wallet below, then paste the transaction hash to credit your account after admin verification.</p>
                <div style="background:#000; padding:12px; border-radius:8px; border:1px solid #333; color:white; margin-bottom:10px;">Address: <strong>0xDEADBEEF000000000000000000000000DEADBEEF</strong></div>
                <input id="cryptoAmount" placeholder="Amount (KES equivalent)" style="padding:10px; background:#000; border:1px solid #333; color:white; width:100%; margin-bottom:8px;" />
                <input id="cryptoHash" placeholder="Transaction Hash" style="padding:10px; background:#000; border:1px solid #333; color:white; width:100%; margin-bottom:8px;" />
                <div style="display:flex; gap:10px;">
                    <button onclick="submitCryptoDeposit()" style="flex:1; background:#00ff88; color:black; padding:12px; border-radius:8px; font-weight:800;">Submit</button>
                    <button onclick="document.getElementById('cryptoDepositModal').remove()" style="flex:1; background:#333; color:white; padding:12px; border-radius:8px;">Cancel</button>
                </div>
            </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', modalHtml);
};

window.submitCryptoDeposit = async function() {
        const amount = document.getElementById('cryptoAmount').value.trim();
        const hash = document.getElementById('cryptoHash').value.trim();
        if (!amount || !hash) return alert('Amount and transaction hash required');
        try {
                const res = await window.API.depositCrypto({ amount, txhash: hash });
                if (res && res.success) {
                        alert('Deposit submitted. Awaiting admin verification.');
                        document.getElementById('cryptoDepositModal').remove();
                } else {
                        alert(res?.message || 'Failed to submit deposit');
                }
        } catch (e) { console.error(e); alert('Network error'); }
};

window.showUpgradeTerms = function() {
    const content = document.querySelector('#upgradeModal .modal-content');
    content.innerHTML = `
        <h2 style="color: #00ff88; margin-bottom: 15px;">Terms & Conditions</h2>
        <div style="text-align: left; color: #888; font-size: 0.75rem; max-height: 200px; overflow-y: auto; background: #000; padding: 15px; border-radius: 10px; margin-bottom: 20px; border: 1px solid #222;">
            1. Elite status is valid for exactly 60 days (2 months).<br>
            2. The fee of 1,500 sKES is non-refundable.<br>
            3. Odds boosts apply to selected high-liquidity markets.<br>
            4. Automated renewals will be prompted at the end of the term.<br>
            5. Users must maintain a positive standing; abuse of odds may result in revocation.<br>
            6. Payments are settled instantly from your Soko Wallet.
        </div>
        <button onclick="window.confirmUpgradeAmount()" style="width: 100%; background: #00ff88; color: black; border: none; padding: 15px; border-radius: 10px; font-weight: 800; cursor: pointer;">Agree & Continue</button>
    `;
};

window.confirmUpgradeAmount = function() {
    const content = document.querySelector('#upgradeModal .modal-content');
    content.innerHTML = `
        <h2 style="color: #ffaa00; margin-bottom: 15px;">Final Confirmation</h2>
        <p style="color: white; margin-bottom: 25px;">Confirm deduction of <strong>1,500 sKES</strong> from your balance for a 2-month Elite Contract?</p>
        <div style="display: flex; gap: 10px;">
            <button onclick="window.processUpgradeFinal()" id="finalUpgradeBtn" style="flex: 2; background: #00ff88; color: black; border: none; padding: 15px; border-radius: 10px; font-weight: 800; cursor: pointer;">Confirm & Pay</button>
            <button onclick="document.getElementById('upgradeModal').remove()" style="flex: 1; background: #333; color: white; border: none; padding: 15px; border-radius: 10px; cursor: pointer;">Cancel</button>
        </div>
    `;
};

window.processUpgradeFinal = async function() {
    const btn = document.getElementById('finalUpgradeBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerText = "Processing...";
    }

    try {
        const res = await window.API.upgradeAccount();
        if (res && res.success) {
            alert("🚀 Welcome to the Elite! Check your email for your Certificate.");
            document.getElementById('upgradeModal').remove();
            fetchProfile(); // Refresh balance and UI
        } else {
            alert(res?.message || "Upgrade failed. Check balance.");
            btn.disabled = false;
            btn.innerText = "Confirm & Pay";
        }
    } catch (err) {
        console.error(err);
        alert("Connection error during upgrade.");
        if (btn) {
            btn.disabled = false;
            btn.innerText = "Confirm & Pay";
        }
    }
};

window.handleGlobalSearch = function(query) {
    if (window.state) {
        window.state.search = query.toLowerCase().trim();
    }
    if (typeof window.applyStateAndRender === 'function') {
        window.applyStateAndRender();
    }
};

window.deleteNotification = async function(id, event) {
    if (event) event.stopPropagation();
    try {
        const res = await apiFetch(`notifications/${id}`, { method: 'DELETE' });
        if (res?.success) {
            const noteEl = event?.target.closest('.notification-row');
            if (noteEl) noteEl.remove();
            
            const container = document.getElementById('noteListContainer');
            if (container && !container.querySelector('.notification-row')) {
                container.innerHTML = '<div style="color:#555; text-align:center; padding:40px 20px; font-size:0.9rem;">no notification or caught up</div>';
                const readAllBtn = container.parentElement.querySelector('button[onclick*="markNotificationsRead"]');
                if (readAllBtn) readAllBtn.remove();
            }
            updateNotificationBadge();
        }
    } catch (e) { console.error("Delete notification failed:", e); }
};

window.toggleNotificationCenter = async function() {
    let modal = document.getElementById('notificationModal');
    if (modal) return modal.remove();

    try {
        const res = await apiFetch('notifications');
        const notes = res?.notifications || [];
        
        const modalHtml = `
            <div id="notificationModal" onclick="if(event.target === this) this.remove()" style="position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:100010; display:flex; justify-content:center; align-items:center; backdrop-filter: blur(4px);">
                <div style="background:#1a1b23; width:90%; max-width:400px; padding:25px; border-radius:16px; border:1px solid #333; position: relative;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                        <h3 style="color:white; margin:0; font-size: 1.1rem;">Notifications Center</h3>
                        <button onclick="document.getElementById('notificationModal').remove()" style="background:none; border:none; color:gray; font-size:1.5rem; cursor:pointer;">✕</button>
                    </div>
                    <div id="noteListContainer" style="max-height:400px; overflow-y:auto;">
                        ${notes.length ? notes.map(n => `
                            <div class="notification-row" style="padding:15px 0; border-bottom:1px solid #222; opacity: ${n.is_read ? '0.6' : '1'}; display: flex; justify-content: space-between; align-items: flex-start;">
                                <div style="flex: 1; padding-right: 10px;">
                                    <div style="color:${n.type === 'update' ? '#ffaa00' : '#00ff88'}; font-size:0.85rem; font-weight:bold;">${n.title} ${n.type === 'update' ? '🚀' : ''}</div>
                                    <div style="color:#eee; font-size:0.8rem; margin-top:5px; line-height: 1.4;">${n.message}</div>
                                    <div style="color:#555; font-size:0.65rem; margin-top:8px;">${new Date(n.created_at).toLocaleString([], {dateStyle:'medium', timeStyle:'short'})}</div>
                                </div>
                                <button onclick="window.deleteNotification('${n.id}', event)" style="background:none; border:none; color:#ff4d4d; opacity: 0.6; font-size:1rem; cursor:pointer; padding: 5px;">🗑️</button>
                            </div>
                        `).join('') : '<div style="color:#555; text-align:center; padding:40px 20px;">no notification or caught up</div>'}
                    </div>
                    ${notes.length ? `<button onclick="window.markNotificationsRead()" style="width:100%; margin-top:20px; background:#111; border:1px solid #333; color:#aaa; padding:12px; border-radius:10px; font-weight: bold; cursor:pointer; font-size: 0.8rem;">Mark all as read</button>` : ''}
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHtml);
    } catch (e) { console.error(e); }
};

window.markNotificationsRead = async function() {
    await apiFetch('notifications/read-all', { method: 'POST' });
    document.getElementById('notificationModal')?.remove();
    updateNotificationBadge();
};

async function updateNotificationBadge() {
    const res = await apiFetch('notifications');
    const unread = res?.notifications?.filter(n => !n.is_read).length || 0;
    const badge = document.getElementById('noteBadge');
    if (badge) {
        badge.style.display = unread > 0 ? 'flex' : 'none';
        badge.innerText = unread;
    }
}

window.switchBetTab = async function(status, btnElement) {
    const container = document.getElementById('bet-container');
    if (!container) return;

    // UI: Update main top-level tab active state
    document.querySelectorAll('.hist-tab').forEach(t => t.classList.remove('active'));
    if (btnElement) btnElement.classList.add('active');

    if (status === 'transactions') {
        container.innerHTML = `
            <div class="transaction-sub-nav" style="display: flex; gap: 8px; margin-bottom: 15px; padding: 5px; position: sticky; top: 0; background: #0b0c10; z-index: 10;">
                <button onclick="filterTransactions('deposit', this)" class="sub-tab active">Deposits</button>
                <button onclick="filterTransactions('withdraw', this)" class="sub-tab">Withdrawals</button>
                <input type="text" placeholder="Search ref..." oninput="filterLocalHistory(this.value)" style="flex:1; background:#111; border:1px solid #333; color:white; border-radius:8px; padding:5px 10px; font-size:0.75rem;">
            </div>
            <div id="transaction-list-view"></div>
        `;
        filterTransactions('deposit');
    } else {
        // HISTORY CARRIER
        // This ensures the sub-nav is only drawn once even if you click 'Won' or 'Lost'
        container.innerHTML = `
            <div class="history-nav" style="display: flex; gap: 4px; margin-bottom: 15px; padding: 5px; position: sticky; top: 0; background: #0b0c10; z-index: 10; overflow-x: auto;">
                <button onclick="refreshBets('active', this)" class="sub-tab ${status === 'active' ? 'active' : ''}">Active</button>
                <button onclick="refreshBets('won', this)" class="sub-tab ${status === 'won' ? 'active' : ''}">Won</button>
                <button onclick="refreshBets('lost', this)" class="sub-tab ${status === 'lost' ? 'active' : ''}">Lost</button>
                <button onclick="refreshBets('cancelled', this)" class="sub-tab ${status === 'cancelled' ? 'active' : ''}">Cancelled</button>
            </div>
            <div id="predictions-list-view"></div>
        `;
        // Load the specific status
        refreshBets(status);
    }
};

window.filterLocalHistory = function(query) {
    const items = document.querySelectorAll('.market-card, .transaction-item');
    items.forEach(el => {
        const text = el.innerText.toLowerCase();
        el.style.display = text.includes(query.toLowerCase()) ? 'block' : 'none';
    });
};

window.filterTransactions = async function(type, btnElement) {
    if (btnElement) {
        document.querySelectorAll('.transaction-sub-nav .sub-tab').forEach(b => b.classList.remove('active'));
        btnElement.classList.add('active');
    }

    const listView = document.getElementById('transaction-list-view');
    if (!listView) return;

    listView.innerHTML = '<div class="loading-state" style="padding:20px; color:gray;">Syncing records...</div>';

    try {
        const history = await window.API.fetchTransactions();
        console.log(`[DEBUG] Received ${history?.length || 0} items from API`);

        if (!history || !Array.isArray(history) || history.length === 0) {
            listView.innerHTML = `<div class="empty-state">No records found.</div>`;
            return;
        }

        const filtered = history.filter(item => {
            if (!item) return false;
            const itemType = (item.type || '').trim().toLowerCase();
            if (type === 'deposit') {
                return ['stk_request', 'deposit', 'referral_bonus', 'crypto'].includes(itemType);
            }
            return itemType === 'withdraw';
        });

        if (filtered.length === 0) {
            listView.innerHTML = `<div class="empty-state">No ${type} records found.</div>`;
            return;
        }

        listView.innerHTML = filtered.map(item => window.renderTransactionItem(item)).join('');
    } catch (err) {
        console.error("FilterTransactions Error:", err);
        listView.innerHTML = '<div class="empty-state" style="color:#ff4444;">Failed to load transaction history.</div>';
    }
};

function toggleSidebar(forceClose = false) {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');

    if (!sidebar || !overlay) return;

    if (forceClose) {
        sidebar.classList.remove('active');
        overlay.classList.remove('active');
        return;
    }

    sidebar.classList.toggle('active');
    overlay.classList.toggle('active');
}

window.toggleSidebar = toggleSidebar;

let selectedAvatarFile = null;

function initAvatarUpload() {
    const input = document.getElementById("avatarInput");
    const saveBtn = document.getElementById("saveAvatarBtn");
    const cancelBtn = document.getElementById("cancelAvatarBtn");
    const avatar = document.getElementById("userAvatar");
    const actions = document.getElementById("avatarActions");

    if (!input || !saveBtn || !cancelBtn || !avatar || !actions) return;

    // SELECT → PREVIEW
    input.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (!file) return;

        selectedAvatarFile = file;

        const reader = new FileReader();
        reader.onload = () => {
            avatar.src = reader.result;
        };
        reader.readAsDataURL(file);

        actions.classList.add("active"); // show buttons
    });

    // SAVE → UPLOAD
    saveBtn.onclick = async () => {
        if (!selectedAvatarFile) return;

        const formData = new FormData();
        formData.append("avatar", selectedAvatarFile);

        try {
            const token = localStorage.getItem("token");
            if (!token) return alert("You must be logged in to save your avatar.");

            const res = await fetch(apiUrl('/api/update-avatar'), {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`
                },
                body: formData
            });

            const data = await res.json();

            if (!res.ok || !data.success) {
                console.error("Avatar upload failed:", data.message || data);
                return alert(data.message || "Avatar upload failed");
            }

            if (data.success) {
                const avatarUrl = window.assetUrl ? window.assetUrl(data.avatarUrl || data.url || data.avatarPath) : (data.avatarUrl || data.url || data.avatarPath);
                avatar.src = avatarUrl;
                const headerAvatar = document.getElementById("headerAvatar");
                if (headerAvatar && avatarUrl) headerAvatar.src = avatarUrl;
                if (avatarUrl) localStorage.setItem('saved_avatar_url', avatarUrl);
                selectedAvatarFile = null;
                actions.classList.remove("active");
                fetchProfile?.();
            }

        } catch (err) {
            console.error(err);
        }
    };

    cancelBtn.onclick = () => {
        selectedAvatarFile = null;
        actions.classList.remove("active");

        fetchProfile();
    };
}
function updateMatchRealtime(update) {
    const card = document.querySelector(`[data-id="${update.id}"]`);
    if (!card) return;

    const scoreEl = card.querySelector(".score");
    if (scoreEl && update.score) {
        scoreEl.textContent = update.score;
    }

    const statusEl = card.querySelector(".live-dot");
    if (statusEl && update.status) {
        statusEl.textContent = update.status;
    }
}

/**
 * MODULE ACTIVATION
 */
function activateModules() {
    const sidebarWrapper = document.getElementById("sidebar");
    const sidebar = document.getElementById("mainSidebar");
    const overlay = document.getElementById("sidebarOverlay");

    if (!sidebarWrapper || !sidebar || !overlay) {
        console.warn("Sidebar elements missing");
        return;
    }

    // --- Universal Search Button (Next to Profile) ---
    const header = document.querySelector('.mobile-header');
    if (header && !document.getElementById('headerSearch')) {
        const searchWrap = document.createElement('div');
        searchWrap.className = 'header-search-wrap';
        searchWrap.style = 'position: relative; display: flex; align-items: center; overflow: visible;';
        searchWrap.innerHTML = `
            <button id="searchToggle" style="background:none; border:none; color:white; font-size:1.2rem; cursor:pointer; padding:5px;">🔍</button>
            <input type="text" id="headerSearch" placeholder="Search..." oninput="window.handleGlobalSearch(this.value)" 
                   style="width:0; opacity:0; transition: all 0.3s ease; background:#111; border:1px solid #333; color:white; border-radius:20px; padding:0; font-size:0.8rem; overflow:hidden; position:absolute; right:45px; z-index: 10;">
        `;
        header.insertBefore(searchWrap, document.querySelector('.header-right') || header.lastChild);

        // Notification Bell
        const noteBtn = document.createElement('div');
        noteBtn.style = 'position:relative; margin-right:10px; cursor:pointer; font-size:1.2rem;';
        noteBtn.innerHTML = `
            <span>🔔</span>
            <div id="noteBadge" style="position:absolute; top:-5px; right:-5px; background:#ff4444; color:white; font-size:0.6rem; width:14px; height:14px; border-radius:50%; display:none; align-items:center; justify-content:center; font-weight:bold;">0</div>
        `;
        noteBtn.onclick = () => window.toggleNotificationCenter();
        header.insertBefore(noteBtn, searchWrap);
        updateNotificationBadge();

        document.getElementById('searchToggle').onclick = () => {
            const input = document.getElementById('headerSearch');
            const isHidden = input.offsetWidth === 0;
            input.style.width = isHidden ? '130px' : '0';
            input.style.opacity = isHidden ? '1' : '0';
            input.style.padding = isHidden ? '6px 12px' : '0';
            if (isHidden) input.focus();
        };

        // Assistant chat UI (small toggle + chat box) placed below the search
        if (!document.getElementById('assistantToggle')) {
            const assistWrap = document.createElement('div');
            assistWrap.style = 'position:relative; margin-left:8px;';
            assistWrap.innerHTML = `
                <button id="assistantToggle" style="background:#00d1ff; border:none; color:black; padding:6px 10px; border-radius:14px; cursor:pointer; font-size:1.1rem;">💬</button>
                <div id="assistantBox" style="display:none; position:absolute; right:0; top:40px; width:320px; background:#0b0b0d; border:1px solid #222; padding:10px; border-radius:10px; z-index:10010; color:#ddd;">
                    <div style="display:flex; gap:8px; margin-bottom:8px; align-items:center;">
                        <select id="assistantEngine" style="flex:1; padding:6px; background:#111; color:#fff; border:1px solid #222; border-radius:6px;">
                            <option value="gpt">GPT</option>
                            <option value="gemini">Gemini</option>
                        </select>
                        <button id="assistantClear" style="background:#333; border:none; color:#fff; padding:6px 8px; border-radius:6px;">Clear</button>
                    </div>
                    <div id="assistantMessages" style="height:160px; overflow:auto; background:#050507; padding:8px; border-radius:6px; border:1px solid #111; font-size:0.85rem; margin-bottom:8px;"></div>
                    <div style="display:flex; gap:8px;">
                        <input id="assistantInput" placeholder="Ask the assistant..." style="flex:1; padding:8px; border-radius:8px; background:#111; color:#fff; border:1px solid #222;">
                        <button id="assistantSend" style="background:#00d1ff; border:none; color:black; padding:8px 10px; border-radius:8px;">Send</button>
                    </div>
                </div>
            `;
            header.insertBefore(assistWrap, searchWrap.nextSibling);

            document.getElementById('assistantToggle').onclick = () => {
                const box = document.getElementById('assistantBox');
                if (!box) return;
                box.style.display = box.style.display === 'none' ? 'block' : 'none';
            };

            document.getElementById('assistantSend').onclick = async () => {
                const input = document.getElementById('assistantInput');
                const messagesEl = document.getElementById('assistantMessages');
                const engine = document.getElementById('assistantEngine')?.value || 'gpt';
                const text = (input.value || '').trim();
                if (!text) return;
                const userHtml = `<div style="color:#9ad; margin-bottom:6px;"><strong>You:</strong> ${escapeHtml(text)}</div>`;
                messagesEl.insertAdjacentHTML('beforeend', userHtml);
                input.value = '';
                messagesEl.scrollTop = messagesEl.scrollHeight;

                try {
                    const res = await apiFetch('ai/chat', { method: 'POST', body: { message: text, engine } });
                    if (res && res.success) {
                        const replyHtml = `<div style="color:#cfc; margin-bottom:8px;"><strong>Assistant (${res.engine}):</strong> ${escapeHtml(res.reply || '')}</div>`;
                        messagesEl.insertAdjacentHTML('beforeend', replyHtml);
                        messagesEl.scrollTop = messagesEl.scrollHeight;
                    } else {
                        messagesEl.insertAdjacentHTML('beforeend', `<div style="color:#f88; margin-bottom:6px;">Assistant failed: ${escapeHtml(res?.message || 'error')}</div>`);
                    }
                } catch (e) {
                    messagesEl.insertAdjacentHTML('beforeend', `<div style="color:#f88; margin-bottom:6px;">Assistant error: ${escapeHtml(e.message || e)}</div>`);
                }
            };

            document.getElementById('assistantClear').onclick = () => {
                document.getElementById('assistantMessages').innerHTML = '';
            };
        }
    }

    /**
     * =========================
     * SIDEBAR TOGGLE FIX
     * =========================
     */
    const hamburgerBtn = document.getElementById("hamburgerBtn");

    if (hamburgerBtn) {
        hamburgerBtn.onclick = () => {
            sidebarWrapper.classList.add("active");
            overlay.classList.add("active");
        };
    }

    overlay.onclick = () => {
        sidebarWrapper.classList.remove("active");
        overlay.classList.remove("active");
    };
    // Removed sidebar category filter listeners per request.
  
    const profileBtn = document.getElementById("profileBtn"); // FIXED HERE

    if (profileBtn) {
        profileBtn.onclick = () => {
            toggleAccountCenter?.();
        };
    }

    /**
     * =========================
     * LOGOUT
     * =========================
     */
    const logoutBtn = document.getElementById("logoutBtn");

    if (logoutBtn) {
        logoutBtn.onclick = () => {
            localStorage.clear();
            location.href = "login.html";
        };
    }
}
function toggleAccountCenter() {
    const el = document.getElementById("accountCenter");
    if (!el) return;

    const isOpen = el.classList.toggle("active");
    if (isOpen) {
        renderSuperAdminProfile();
    }
}

async function renderSuperAdminProfile() {
    // Restoration: Superadmins now load the standard user profile UI.
    // The special "Management Console" button is injected via fetchProfile in api.js.
    if (typeof fetchProfile === 'function') {
        fetchProfile();
    }
}

window.toggleAccountCenter = toggleAccountCenter;

async function login() {
    const phone = document.getElementById("phone")?.value?.trim();
    const password = document.getElementById("password")?.value;

    if (!phone || !password) {
        return alert("Please fill in all fields");
    }

    try {
        const res = await window.API.login({ phone, password });

        if (res?.success && res.token) {
            localStorage.setItem("token", res.token);
            window.location.href = "index.html";
        } else {
            alert(res?.message || "Login failed");
        }

    } catch (err) {
        console.error("Login error:", err);
        alert("Server error. Check connection.");
    }
}
window.refreshBets = async function(status, btnElement) {
    if (btnElement) {
        document.querySelectorAll('.predictions-nav .sub-tab').forEach(b => b.classList.remove('active'));
        btnElement.classList.add('active');
    }

    const listView = document.getElementById('predictions-list-view');
    if (!listView) return;

    try {
        // Use apiFetch so the request follows the configured backend base.
        const data = await apiFetch(`my-bets?status=${status}`);

        if (data && data.success && data.bets.length > 0) {
            window.allBets = data.bets;
            if (typeof window.renderHistory === 'function') {
                window.renderHistory();
            } else {
                listView.innerHTML = data.bets.map(bet => window.renderBetCard ? window.renderBetCard(bet) : '').join('');
            }
        } else {
            listView.innerHTML = `<div class="empty-state" style="padding: 20px; text-align: center; color: gray;">No ${status} predictions yet.</div>`;
        }
    } catch (err) {
        console.error("RefreshBets Error:", err);
        listView.innerHTML = '<div class="empty-state">Error loading predictions.</div>';
    }
};
window.login = login;

window.openMpesaDashboard = async function(type = 'all') {
    const container = document.getElementById('marketsList');
    if (!container) return;

    try {
        const res = await API.fetchMpesaLog();
        if (res && res.success) {
            // Set a container ID that the socket listener can detect
            container.innerHTML = `<div id="mpesa-log-view">${renderMpesaLog(res.logs, type)}</div>`;
            window.scrollTo(0, 0);
        }
    } catch (err) {
        console.error("Dashboard failed:", err);
        showToast("Access Denied or Connection Error", "red");
    }
};

window.filterLogSearch = function() {
    const query = document.getElementById('logSearchInput').value.toLowerCase();
    const items = document.querySelectorAll('.log-item');
    
    items.forEach(item => {
        const text = item.innerText.toLowerCase();
        if (text.includes(query)) {
            item.style.display = 'block';
        } else {
            item.style.display = 'none';
        }
    });
};

function renderMpesaLog(logs, type = 'all') {
    if (!logs || !logs.length) return '<div class="empty-state">No M-Pesa records found.</div>';
    return logs
        .filter(log => type === 'all' || (type === 'deposit' ? ['stk_request', 'deposit'].includes(log.type) : log.type === type))
        .map(log => window.renderTransactionItem ? window.renderTransactionItem(log) : '')
        .join('');
}
