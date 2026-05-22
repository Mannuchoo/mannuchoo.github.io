
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
