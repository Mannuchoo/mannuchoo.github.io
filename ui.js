window.state = window.state || {
    allMarkets: [],
    filteredMarkets: [],
    category: localStorage.getItem("last_category") || "all",
    sportsType: localStorage.getItem("last_sports_type") || "",
    search: "",
    loading: true,
    lastUpdate: null,
    currentHistoryTab: "active"
};

const state = window.state;

function syncMarketMap(markets) {
    window.marketMap = {};
    (markets || []).forEach((market) => {
        if (market?.id) window.marketMap[market.id] = market;
    });
}

function normalizeCategory(cat) {
    if (!cat) return "unknown";
    return cat.toString().toLowerCase().trim();
}

window.setCategory = function (category) {
    if (!window.state) {
        console.warn("state not ready yet");
        return;
    }

    const active = normalizeCategory(category || "all");
    window.state.category = active;
    if (active !== "sports") {
        window.state.sportsType = "";
        localStorage.removeItem("last_sports_type");
    }
    localStorage.setItem("last_category", active);
    document.querySelectorAll('.category-filter-row .pill').forEach(pill => {
        pill.classList.remove('active');
        const pillCat = normalizeCategory(pill.dataset.cat || pill.innerText);
        if (pillCat === active) {
            pill.classList.add('active');
        }
    });

    applyStateAndRender();
};

window.setSportsType = function (sport) {
    window.state.category = "sports";
    window.state.sportsType = normalizeCategory(sport || "");
    localStorage.setItem("last_category", "sports");
    if (window.state.sportsType) {
        localStorage.setItem("last_sports_type", window.state.sportsType);
    } else {
        localStorage.removeItem("last_sports_type");
    }
    document.querySelectorAll('.category-filter-row .pill').forEach(pill => {
        const pillCat = normalizeCategory(pill.dataset.cat || pill.innerText);
        pill.classList.toggle('active', pillCat === "sports");
    });
    applyStateAndRender();
};

function applyStateAndRender() {
    let filtered = state.allMarkets || [];
    const active = state.category || "all";
    
    if (active !== "all") {
        filtered = filtered.filter(m => {
            const cat = normalizeCategory(m.category);
            if (active === "football") {
                return (
                    cat === "football" ||
                    cat === "soccer" ||
                    m.id?.startsWith("fb_") ||
                    (m.league?.toLowerCase().includes("football")) ||
                    (m.league?.toLowerCase().includes("premier")) ||
                    (m.league?.toLowerCase().includes("laliga"))
                );
            }
            if (active === "sports") {
                return cat === "sports" || cat === "football" || m.id?.startsWith("sp_") || m.id?.startsWith("fb_");
            }
            return cat === active;
        });
    }
    
    if (state.search) {
        filtered = filtered.filter(m => 
            (m.title || "").toLowerCase().includes(state.search) ||
            (m.description || "").toLowerCase().includes(state.search)
        );
    }

    state.filteredMarkets = filtered;
    renderFilteredMarkets();
    renderTrending(); // Now independent of filtered data
}

window.applyStateAndRender = applyStateAndRender;

function renderApp() {
    renderFilteredMarkets();
    renderTrending();
    if (document.getElementById("greetingText")) {
        loadGreeting();
    }
    // The balance display is now handled by renderBalanceDisplay in app.js
    // which uses renderBalanceCard.
}

// New function to render the "floating and sexy" balance card
function renderBalanceCard(balance) {
    const formattedBalance = Number(balance).toFixed(2);
    return `
        <div class="balance-card-dark" style="
            background: linear-gradient(135deg, #00ff88, #00c96b); /* Sexy gradient */
            border: 1px solid rgba(0, 255, 136, 0.4);
            border-radius: 20px;
            padding: 20px;
            color: black; /* Text color for the card */
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            align-items: flex-start;
            box-shadow: 0 10px 30px rgba(0, 255, 136, 0.3); /* Soft glow */
            position: relative;
            overflow: hidden;
            min-height: 120px;
            flex: 0 1 420px; /* Keep original flex properties */
            min-width: 260px;
        ">
            <div style="font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: rgba(0,0,0,0.7);">
                Your Balance
            </div>
            <div style="font-size: 2.2rem; font-weight: 900; line-height: 1; margin-top: 5px; color: black;">
                ${formattedBalance} <span style="font-size: 1.2rem; font-weight: 700;">sKES</span>
            </div>
            <div style="display: flex; gap: 10px; margin-top: 15px; width: 100%;">
                <button onclick="window.triggerDeposit()" style="flex: 1; padding: 10px 15px; border-radius: 10px; border: none; background: rgba(0,0,0,0.15); color: black; font-weight: 700; font-size: 0.85rem; cursor: pointer; transition: background 0.2s ease;">💰 Deposit</button>
                <button onclick="window.toggleWithdrawModal()" style="flex: 1; padding: 10px 15px; border-radius: 10px; border: none; background: rgba(0,0,0,0.15); color: black; font-weight: 700; font-size: 0.85rem; cursor: pointer; transition: background 0.2s ease;">💸 Withdraw</button>
            </div>
        </div>
    `;
}
/**
 * TRENDING
 */
function renderTrending() {
    const container = document.getElementById('ongoing');
    if (!container) return;

    // Requirement: Constant across categories, Tech & European Football only, No News
    const source = (state.allMarkets || []).filter(m => {
        const cat = normalizeCategory(m.category);
        if (cat === 'tech') return true;
        
        // European Football logic: Check league/country meta for European identifiers
        if (cat === 'football' || m.id?.startsWith('fb_')) {
            const text = `${m.league || ''} ${m.country || ''}`.toLowerCase();
            const euroKeywords = [
                'england', 'spain', 'germany', 'italy', 'france', 'portugal', 'netherlands', 'belgium', 'europe',
                'premier league', 'la liga', 'bundesliga', 'serie a', 'ligue 1', 'champions league', 'europa league', 'euro',
                'gb', 'es', 'de', 'it', 'fr', 'pt', 'nl', 'be'
            ];
            return euroKeywords.some(key => text.includes(key));
        }
        return false;
    });
    
    const top = source
        .filter(m => m?.id)
        .sort((a, b) => {
            // Ranking Algorithm: Priority to Live matches, Tech innovation, High Volume, and High Odds
            const score = (m) => {
                const vol = Number(m.home_volume || m.away_volume || m.volume || m.total_volume || 0);
                const maxOdds = Math.max(Number(m.oddsA || 0), Number(m.oddsB || 0));
                const isTech = m.category === 'tech' ? 30000 : 0;
                const isLive = m.status === 'live' ? 100000 : 0;
                
                // Rank by status + category weight + volume + odds weight
                return isLive + isTech + vol + (maxOdds * 500);
            };
            return score(b) - score(a);
        }); // Removed .slice() to make it "endless"

    container.innerHTML = top.map(m => {
        const safeTitle = (m.title || "").replace(/'/g, "\\'");
        return `
        <div class="ongoing-card" data-id="${m.id}" onclick="openTrendingMarket('${m.id}')">
            <div class="category-tag">🔥 HOT</div>
            <div class="ongoing-title">${escapeHtml(m.title || m.betQuestion || 'Market')}</div>

            <div class="betting-row">
                <button class="bet-btn btn-yes" 
                    data-id="${m.id}" 
                    data-choice="Yes" 
                    data-title="${safeTitle}"
                    onclick="event.stopPropagation(); openBetModal('${m.id}', '${safeTitle}', 'Yes')">YES</button>
                <button class="bet-btn btn-no" 
                    data-id="${m.id}" 
                    data-choice="No" 
                    data-title="${safeTitle}"
                    onclick="event.stopPropagation(); openBetModal('${m.id}', '${safeTitle}', 'No')">NO</button>
            </div>
        </div>
    `}).join('');
}

function openTrendingMarket(id) {
    const market = window.marketMap?.[id];
    if (!market) return;

    if (market.category) {
        setCategory(market.category === "football" || market.id?.startsWith("fb_") ? "sports" : market.category);
    }

    openMarket(id);
}

/**
 * MARKET LIST
 */
function renderFilteredMarkets() {
    const mainGrid = document.getElementById("marketsList");
    if (!mainGrid) return;

    const allMarkets = (state.filteredMarkets || []);

    if (state.category === "sports") {
        renderSportsPage(mainGrid, allMarkets);
        return;
    }

    // 1. Split into groups
    const live = allMarkets.filter(m => m.status === 'live');
    const news = allMarkets.filter(m => m.category === 'news');
    const upcoming = allMarkets.filter(m => m.status !== 'live' && m.category !== 'news')
        .sort((a, b) => (a.country || "Z").localeCompare(b.country || "Z"));

    let html = "";

    // Add Back Button if a specific category is active
    if (state.category !== "all") {
        html += `<button class="pill" onclick="window.setCategory('all')" style="margin-bottom:15px; background:#333; color:white; border:none; padding:8px 15px; border-radius:20px; cursor:pointer;">← Back to All Markets</button>`;
    }

    // 2. Render Live Football Section
    if (live.length > 0) {
        html += `<div class="main-category-label" style="color: #ff4d4d; font-weight: 800; padding: 10px 0;">🔴 LIVE NOW</div>`;
        live.forEach(m => html += createMarketCard(m));
    }

    // 2. Render News Feed (compact cards only; expanded feed loads on demand)
    if (news.length > 0) {
        html += `<div class="main-category-label" style="color: #00ff88; font-weight: 800; padding: 20px 0 10px 0;">📰 LATEST NEWS</div>`;
        news.forEach(m => html += createMarketCard(m));
        // Collapsible news feed (hidden by default to avoid showing extra content)
        html += `
            <div id="newsFeedContainer" style="margin-top:12px; display:none;">
                ${renderNewsFeed(news)}
            </div>
            <div style="margin-top:10px;">
                <button id="toggleNewsFeedBtn" class="pill" onclick="(function(){
                    const c = document.getElementById('newsFeedContainer');
                    const b = document.getElementById('toggleNewsFeedBtn');
                    if (!c) return;
                    if (c.style.display === 'none') { c.style.display = 'block'; b.innerText = 'Hide News Feed'; }
                    else { c.style.display = 'none'; b.innerText = 'Show News Feed'; }
                })()">Show News Feed</button>
            </div>
        `;
    }

    // 4. Render Upcoming Football Section
    if (upcoming.length > 0) {
        html += `<div class="main-category-label" style="color: #aaa; font-weight: 800; padding: 20px 0 10px 0;">📅 UPCOMING MATCHES</div>`;
        let lastCountry = "";
        upcoming.forEach(m => {
            const country = m.country || "GLOBAL";
            if (country !== lastCountry) {
                html += `<div class="section-label" style="font-size:0.7rem; color:#666; margin-top:10px;">— ${country.toUpperCase()} —</div>`;
                lastCountry = country;
            }
            html += createMarketCard(m);
        });
    }

    mainGrid.innerHTML = html || `<div style="padding:20px;">No markets found. Searching for elite aura...</div>`;
}

function renderSportsPage(container, sportsMarkets) {
    const sportsCatalog = ["Football", "NPL", "Basketball", "Hockey", "Baseball", "Volleyball", "Rugby", "Handball"];
    const source = (sportsMarkets || [])
        .filter(m => normalizeCategory(m.category) === "sports" || normalizeCategory(m.category) === "football" || m.id?.startsWith("sp_") || m.id?.startsWith("fb_"))
        .filter(m => {
            const title = String(m.title || "").toLowerCase();
            return title && !["home vs away", "unknown vs unknown"].includes(title);
        });
    const selected = normalizeCategory(state.sportsType || "");
    const sportLabelFor = (m) => normalizeCategory(m.category) === "football" || m.id?.startsWith("fb_") ? "Football" : (m.country || m.sport || "Other");
    const sportNames = [...new Set([...sportsCatalog, ...source.map(sportLabelFor)])]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));

    let html = `
        <div class="sports-page">
            <div class="sports-page-header">
                <button class="pill" onclick="window.setCategory('all')" style="background:#333;color:white;border:none;">Back to All Markets</button>
                ${selected ? `<button class="pill active" onclick="window.setSportsType('')">All Sports</button>` : ''}
            </div>
    `;

    if (!source.length) {
        container.innerHTML = `${html}
            <div class="empty-state" style="padding:24px;">
                Sports markets are syncing. Check again shortly.
            </div>
        </div>`;
        return;
    }

    if (!selected) {
        html += `
            <div class="main-category-label" style="color:#00ff88;font-weight:800;padding:10px 0;">SPORTS</div>
            <div class="sports-category-grid">
                ${sportNames.map(name => {
                    const normalized = normalizeCategory(name);
                    const count = source.filter(m => normalizeCategory(sportLabelFor(m)) === normalized).length;
                    return `
                        <button class="sports-category-card" onclick="window.setSportsType('${escapeHtml(normalized)}')">
                            <span>${escapeHtml(name)}</span>
                            <small>${count} matches</small>
                        </button>
                    `;
                }).join('')}
            </div>
        </div>`;
        container.innerHTML = html;
        return;
    }

    const label = sportNames.find(name => normalizeCategory(name) === selected) || selected;
    const matches = source
        .filter(m => normalizeCategory(sportLabelFor(m)) === selected)
        .sort((a, b) => `${a.league || ""} ${a.title || ""}`.localeCompare(`${b.league || ""} ${b.title || ""}`));

    html += `<div class="main-category-label" style="color:#00ff88;font-weight:800;padding:10px 0;">${escapeHtml(label).toUpperCase()} MATCHES</div>`;

    let lastLeague = "";
    if (!matches.length) {
        html += `<div class="empty-state" style="padding:24px;">${escapeHtml(label)} matches are syncing. Check again shortly.</div>`;
    }
    matches.forEach(m => {
        const league = m.league || "Global";
        if (league !== lastLeague) {
            html += `<div class="section-label" style="font-size:0.7rem;color:#777;margin-top:12px;">${escapeHtml(league.toUpperCase())}</div>`;
            lastLeague = league;
        }
        html += createMarketCard(m);
    });

    container.innerHTML = `${html}</div>`;
}
function createMarketCard(m) {
    const isFootball = m.category === "football" || m.id?.startsWith("fb_");
    const isSports = m.category === "sports" || m.id?.startsWith("sp_");
    const isNews = m.category === "news";
    const safeTitle = ((isNews ? m.betQuestion : m.title) || "").replace(/'/g, "\\'");
    const displayTitle = escapeHtml(isNews ? (m.betQuestion || m.title) : m.title) || 'Unknown Market';

    // Determine badge and color
    let badgeText = (isSports ? `${m.country || 'Sports'}${m.league ? ` - ${m.league}` : ''}` : (m.league || m.source || "GLOBAL")).toUpperCase();
    let badgeColor = isNews ? "#00ff88" : "#888";
    const boostBadge = m.is_boosted ? `<span style="background: rgba(255, 214, 0, 0.12); color:#ffd60a; border:1px solid rgba(255,214,0,0.2); padding:4px 10px; border-radius:999px; font-size:0.68rem; font-weight:700;">BOOSTED +10%</span>` : '';

    // For news items we show a compact card; full content only in modal
    const textSnippet = escapeHtml((m.description || m.content || '').slice(0, 120));
    const mediaPreview = '';
    const miniProbBar = isNews ? renderMiniProbBar(m) : '';
    const sparkline = isNews ? renderNewsSparkline(m.id) : '';

    return `
<div class="market-card ${isNews ? 'news-style' : ''}" 
     data-id="${m.id}" 
     onclick="openMarket('${m.id}')"
     style="border-left: 3px solid ${isNews ? '#00ff88' : 'transparent'};">
     
    <div style="display:flex; justify-content:space-between; margin-bottom:10px; gap:10px; flex-wrap:wrap;">
        <span class="league-tag" style="color:${badgeColor}; border-color:${badgeColor}; font-size:0.6rem;">
            ${badgeText}
        </span>
        <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
            ${boostBadge}
            <span class="live-dot" style="font-size:0.65rem; color: ${m.status === 'live' ? '#ff4d4d' : '#555'}">
                ● ${m.status === "live" ? "LIVE" : isNews ? "NEWS" : "UPCOMING"}
            </span>
        </div>
    </div>

    ${isFootball || isSports 
        ? `
        <div style="display:flex; align-items:center; gap:12px; margin:10px 0;">
            <div class="team-abbr">${(m.title.split(" vs ")[0] || "??").substring(0,3).toUpperCase()}</div>
            <div style="flex:1; font-weight:700; font-size:0.95rem; color:white;">${displayTitle}</div>
        </div>
        `
        : `
        <div style="margin:10px 0;">
            <h3 style="font-size:0.95rem; color:white; line-height:1.3;">${displayTitle}</h3>
            ${isNews ? `<div style="color:#9ca3af; font-size:0.78rem; margin-top:6px;">Click to open for headline context</div>` : ''}
        </div>
        `
    }

    ${''}

    <div style="display:flex; align-items:center; gap:12px; margin-top:8px;">
        ${miniProbBar}
        ${sparkline || ''}
    </div>

    <div class="betting-row" style="display: flex; gap: 8px; margin-top: 15px;">
        <button class="bet-btn btn-yes" onclick="event.stopPropagation(); openBetModal('${m.id}', '${safeTitle}', 'Yes')">
                    YES ${m.oddsA ? `(${m.oddsA})` : ''} 
        </button>
        <button class="bet-btn btn-no" onclick="event.stopPropagation(); openBetModal('${m.id}', '${safeTitle}', 'No')">
            NO ${m.oddsB ? `(${m.oddsB})` : ''}
        </button>
    </div>
    ${renderPolymarketBar(m)}
</div>
`;
}

function getMarketImpliedProbabilities(market) {
    const yesOdds = Number(market.oddsA || market.odds_yes || market.yes_odds || 1.9);
    const noOdds = Number(market.oddsB || market.odds_no || market.no_odds || 1.9);
    if (yesOdds <= 0 || noOdds <= 0) return { yes: 50, no: 50 };

    const yesValue = 1 / yesOdds;
    const noValue = 1 / noOdds;
    const total = yesValue + noValue;
    const yes = Math.max(5, Math.min(95, Math.round((yesValue / total) * 100)));
    const no = 100 - yes;

    return { yes, no };
}

function renderPolymarketBar(market) {
    const { yes, no } = getMarketImpliedProbabilities(market);
    const volume = Number(market.home_volume || market.away_volume || market.volume || market.total_volume || 0);

    return `
        <div style="margin-top: 14px;">
            <div style="display:flex; justify-content:space-between; font-size:0.72rem; color:#bbb; margin-bottom:6px;">
                <span>YES ${yes}%</span>
                <span>NO ${no}%</span>
            </div>
            <div style="height:10px; border-radius:999px; overflow:hidden; background:#111; display:flex;">
                <div style="width:${yes}%; background: linear-gradient(90deg, #00ff88, #00d17a);"></div> 
                <div style="width:${no}%; background: linear-gradient(90deg, #ff4d4d, #d12020);"></div>
            </div>
            ${volume ? `<div style="font-size:0.7rem; color:#777; margin-top:8px;">Volume: sKES ${volume.toFixed(0)}</div>` : ''}
        </div>
    `;
}

function renderProbabilityChart(market) {
    const { yes, no } = getMarketImpliedProbabilities(market);
    const volume = Number(market.home_volume || market.away_volume || market.volume || market.total_volume || 0);

    return `
        <div style="margin: 18px 0 8px; padding: 14px; border: 1px solid #222; border-radius: 12px; background: rgba(255,255,255,0.02);">
            <div style="display:flex; justify-content:space-between; font-size:0.76rem; color:#bbb; margin-bottom:8px;">
                <span>YES ${yes}%</span>
                <span>NO ${no}%</span>
            </div>
            <div style="height:10px; background:#111; border-radius:999px; overflow:hidden; display:flex;">
                <div style="width:${yes}%; background: linear-gradient(90deg, #00ff88, #00d17a);"></div> 
                <div style="width:${no}%; background: linear-gradient(90deg, #ff4d4d, #d12020);"></div>
            </div>
            <div style="display:flex; justify-content:space-between; margin-top:10px; font-size:0.72rem; color:#777;">
                <span>Volume: sKES ${volume.toFixed(0)}</span>
                <span>Confidence: ${Math.max(1, yes)}%</span>
            </div>
        </div>
    `;
}

function renderMiniProbBar(market) {
    const { yes, no } = getMarketImpliedProbabilities(market);
    return `
        <div style="margin-top:8px;">
            <div style="height:8px; border-radius:999px; overflow:hidden; background:#0b0c10; display:flex; width:120px;">
                <div style="width:${yes}%; background: linear-gradient(90deg, #00ff88, #00d17a);"></div> 
                <div style="width:${no}%; background: linear-gradient(90deg, #ff4d4d, #d12020);"></div>
            </div>
            <div style="font-size:0.7rem; color:#777; margin-top:6px;">YES ${yes}% • NO ${no}%</div>
        </div>
    `;
}

function renderNewsSparkline(id) {
    // deterministic pseudo-random generator from id
    let h = 0;
    for (let i = 0; i < id.length; i++) h = ((h << 5) - h) + id.charCodeAt(i);
    h = Math.abs(h);
    const points = 12;
    const vals = new Array(points).fill(0).map((_, i) => {
        // mix hash with index for variety
        const v = ((h >> (i % 16)) & 0xff) / 255;
        // scale to [0.1,0.9]
        return 0.1 + (v * 0.8);
    });

    const width = 80, height = 24;
    const step = width / (points - 1);
    const coords = vals.map((v, i) => `${(i * step).toFixed(1)},${(height - v * height).toFixed(1)}`).join(' ');

    return `
        <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="display:block;">
            <polyline fill="none" stroke="#00ff88" stroke-width="1.6" points="${coords}" stroke-linecap="round" stroke-linejoin="round" />
            <polyline fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="6" points="${coords}" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
    `;
}

function renderNewsFeed(news = []) {
    if (!news.length) return '';
    return `
        <div style="margin-top:16px; padding:16px; border:1px solid #222; border-radius:14px; background:#080b10;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <span style="color:#00ff88; font-size:0.8rem; font-weight:700; letter-spacing:0.5px;">LATEST API NEWS</span>
                <span style="color:#777; font-size:0.72rem;">Powered by NewsAPI</span>
            </div>
            ${news.slice(0, 5).map(item => `
                <a href="${escapeHtml(item.url || '#')}" target="_blank" rel="noopener noreferrer" style="display:block; color:#fff; text-decoration:none; margin-bottom:12px;">
                    <strong style="font-size:0.92rem;">${escapeHtml(item.title || item.betQuestion || item.displayHeadline || item.description || 'News item')}</strong>
                    <div style="font-size:0.72rem; color:#999; margin-top:4px;">${escapeHtml(item.source || item.country || 'Source')}${item.url ? ` · ${new Date(item.timestamp || item.publishedAt || Date.now()).toLocaleDateString()}` : ''}</div>
                </a>
            `).join('')}
        </div>
    `;
}

window.escapeHtml = function(text) {
    if (text === null || text === undefined) return ""; // Fix: Return empty string if null
    return text.toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function linkify(text) {
    if (!text) return "";
    const urlPattern = /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;
    return text.replace(urlPattern, (url) => {
        return `<a href="${url}" target="_blank" style="color: #00ff88; text-decoration: underline;">${url}</a>`;
    });
}

function getYouTubeEmbedUrl(url) {
    if (!url) return null;

    try {
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^www\./, "");

        if (host === "youtu.be") {
            const id = parsed.pathname.split("/").filter(Boolean)[0];
            return id ? `https://www.youtube.com/embed/${id}` : null;
        }

        if (host === "youtube.com" || host === "m.youtube.com") {
            const id = parsed.searchParams.get("v");
            if (id) return `https://www.youtube-nocookie.com/embed/${id}`;

            const parts = parsed.pathname.split("/").filter(Boolean);
            const embedIndex = parts.findIndex(part => ["embed", "shorts", "live"].includes(part));
            if (embedIndex >= 0 && parts[embedIndex + 1]) {
                return `https://www.youtube-nocookie.com/embed/${parts[embedIndex + 1]}`;
            }
        }
    } catch {
        return null;
    }

    return null;
}

function renderMarketMedia(m) {
    const url = (m.media_url || "").trim();
    if (!url) return "";

    const safeUrl = escapeHtml(url);
    const type = (m.media_type || "").toLowerCase();
    const youtubeEmbed = getYouTubeEmbedUrl(url);

    if (youtubeEmbed) {
        return `
            <div class="market-media market-media-video">
                <iframe
                    src="${escapeHtml(youtubeEmbed)}"
                    title="Market video"
                    loading="lazy"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowfullscreen>
                </iframe>
            </div>
        `;
    }

    const looksVideo = type === "video" || /\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(url);
    if (looksVideo) {
        return `
            <video class="market-media" controls playsinline preload="metadata">
                <source src="${safeUrl}">
                Your browser cannot play this video.
            </video>
        `;
    }

    return `<img class="market-media" src="${safeUrl}" alt="Market media" loading="lazy">`;
}

function renderMarketLiveInfo(m) {
    const updatedAt = m.timestamp
        ? new Date(m.timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
        : "Live";

    const start = m.startTime
        ? new Date(m.startTime).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
        : "Not scheduled";

    return `
        <div class="market-live-panel">
            <div>
                <span>Status</span>
                <strong>${escapeHtml((m.status || "open").toUpperCase())}</strong>
            </div>
            <div>
                <span>Starts / Closes</span>
                <strong>${escapeHtml(start)}</strong>
            </div>
            <div>
                <span>Odds</span>
                <strong>YES ${Number(m.oddsA || 1.9).toFixed(2)} / NO ${Number(m.oddsB || 1.9).toFixed(2)}</strong>
            </div>
            <div>
                <span>Volume</span>
                <strong>${Number(m.home_volume || m.volume || 0).toFixed(0)} / ${Number(m.away_volume || 0).toFixed(0)} sKES</strong>
            </div>
            <div>
                <span>Updated</span>
                <strong>${escapeHtml(updatedAt)}</strong>
            </div>
        </div>
    `;
}

function extractStatsValue(stats, statName) {
    if (!Array.isArray(stats)) return { home: null, away: null };
    const normalize = (value) => {
        if (typeof value === 'string' && value.endsWith('%')) return Number(value.replace('%', '')) || 0;
        return Number(value) || 0;
    };

    const home = stats[0]?.statistics?.find(item => item.type?.toLowerCase() === statName.toLowerCase())?.value;
    const away = stats[1]?.statistics?.find(item => item.type?.toLowerCase() === statName.toLowerCase())?.value;

    return { home: normalize(home), away: normalize(away) };
}

function renderStatsBar(stats) {
    const possession = extractStatsValue(stats, 'Ball Possession');
    const shotsOnTarget = extractStatsValue(stats, 'Shots on Goal');
    const totalShots = extractStatsValue(stats, 'Total Shots');
    const possessionLeft = Math.max(0, Math.min(100, possession.home));
    const possessionRight = Math.max(0, Math.min(100, possession.away));

    if (!possession.home && !possession.away) {
        return `<div style="color:#777; font-size:0.85rem; margin-top:10px;">No live statistics are available yet.</div>`;
    }

    return `
        <div style="background:#111; padding:12px; border-radius:10px; border:1px solid #222;">
            <div style="display:flex; justify-content:space-between; font-size:0.75rem; color:#999; margin-bottom:10px;">
                <span>${stats[0]?.team?.name || 'Home'}</span>
                <span>Possession</span>
                <span>${stats[1]?.team?.name || 'Away'}</span>
            </div>
            <div style="height:10px; background:#111; border-radius:999px; overflow:hidden; display:flex; margin-bottom:12px;">
                <div style="width:${possessionLeft}%; background:#00ff88"></div>
                <div style="width:${possessionRight}%; background:#ff4d4d"></div>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; font-size:0.75rem; color:#ccc;">
                <div style="text-align:center;">${shotsOnTarget.home || '-'}<br><small>Shots on Goal</small></div>
                <div style="text-align:center;">${totalShots.home || '-'}<br><small>Total Shots</small></div>
                <div style="text-align:center;">${shotsOnTarget.away || '-'}<br><small>Shots on Goal</small></div>
            </div>
        </div>
    `;
}

function renderLineups(lineups) {
    if (!Array.isArray(lineups) || lineups.length === 0) {
        return `<p style="color:#777; font-size:0.85rem;">Lineup information is not available for this fixture.</p>`;
    }

    const renderTeamLineup = (team) => {
        const title = team.team?.name || 'Team';
        const formation = team.formation ? `Formation: ${escapeHtml(team.formation)}` : '';
        const starters = Array.isArray(team.startXI) ? team.startXI : [];
        const bench = Array.isArray(team.substitutes) ? team.substitutes : [];

        return `
            <div style="flex:1; min-width:180px;">
                <div style="font-size:0.82rem; color:#aaa; margin-bottom:6px;">${escapeHtml(title)} ${formation ? `• ${formation}` : ''}</div>
                <div style="font-size:0.74rem; color:#ccc; line-height:1.4;">
                    ${starters.map(player => `<div>• ${escapeHtml(player.player?.name || player.player?.name || '?')} ${player.number ? `#${player.number}` : ''}</div>`).join('')}
                </div>
                ${bench.length ? `<div style="font-size:0.72rem; color:#777; margin-top:10px;"><strong>Bench:</strong> ${bench.map(player => escapeHtml(player.player?.name || '?')).join(', ')}</div>` : ''}
            </div>
        `;
    };

    return `
        <div style="display:flex; gap:18px; flex-wrap:wrap;">
            ${renderTeamLineup(lineups[0] || {})}
            ${renderTeamLineup(lineups[1] || {})}
        </div>
    `;
}

function renderResolutionInfo(m) {
    const category = (m.category || "market").toLowerCase();
    
    // Updated sourceMap to reflect API-Football for the Active account
    const sourceMap = {
        football: "API-Football match data and official match records",
        crypto: "CoinGecko market data",
        news: "Major public news sources",
        weather: "WeatherAPI forecast and historical weather data",
        politics: "Publicly verifiable official announcements"
    };
    let yesRule = '';
    if (category === 'weather') {
        yesRule = 'YES resolves if the forecast for the specified date matches the observed weather on that date.';
    } else if (category === 'football') {
        yesRule = 'YES resolves if the selected outcome is confirmed by the official final match record.';
    } else {
        yesRule = `YES resolves if the statement in this market is confirmed by ${sourceMap[category] || "a reliable public source"}.`;
    }

    return `
        <div class="resolution-panel" style="background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px; margin: 15px 0; border: 1px solid #333;">
            <div style="margin-bottom: 8px;">
                <span style="color: #888; text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.5px; display: block;">Resolution Source</span>
                <strong style="color: #ddd; font-size: 0.85rem;">${escapeHtml(sourceMap[category] || "Reliable public source")}</strong>
            </div>
            <p style="font-size: 0.8rem; color: #bbb; margin: 8px 0;">${escapeHtml(yesRule)}</p>
            <small style="color: #666; font-size: 0.7rem; display: block; line-height: 1.2;">
                Markets may be voided if the event is cancelled, materially changed, or cannot be verified.
            </small>
        </div>
    `;
}

window.renderTransactionItem = function(item) {
    if (!item || typeof item !== 'object') return '';
    const itemType = (item.type || '').trim().toLowerCase();
    const isDeposit = ['stk_request', 'deposit', 'referral_bonus', 'crypto'].includes(itemType);
    const accentColor = isDeposit ? '#00ff88' : '#ff4444';
    const displayDate = item.timestamp || item.created_at; 
    const status = (item.status || 'pending').toLowerCase();
    
    const label = itemType === 'referral_bonus' ? '🎁 BONUS' : 
                  (itemType === 'crypto' ? '🪙 CRYPTO' :
                  (isDeposit ? '💰 DEPOSIT' : '💸 WITHDRAWAL'));

    return `
        <div class="transaction-item" style="margin-bottom: 12px; border-left: 4px solid ${accentColor}; background: #1a1b23; padding: 15px; border-radius: 12px; display: flex; justify-content: space-between; align-items: center;">
            <div>
                <div style="font-size:0.65rem; color:gray; text-transform: uppercase; margin-bottom: 4px;">${label}</div>
                <div style="font-weight:bold; color: white; font-family: monospace; font-size: 0.85rem; margin-bottom: 4px;">${item.reference || '---'}</div>
                <div style="color: #6b7280; font-size: 0.7rem;">
                    ${new Date(displayDate || Date.now()).toLocaleString([], {dateStyle:'medium', timeStyle:'short'})}
                </div>
            </div>
            <div style="text-align: right;">
                <div style="font-weight:bold; color: white; font-size: 1rem; margin-bottom: 4px;">
                    ${isDeposit ? '+' : ''}${item.amount || 0} <small style="color: #6b7280;">sKES</small> 
                </div>
                <div style="color: ${status === 'completed' || status === 'approved' ? '#00ff88' : '#fbbf24'}; font-size: 0.7rem; font-weight: bold; text-transform: uppercase;">
                    ● ${status}
                </div>
            </div>
        </div>
    `;
};

/**
 * BET CARD
 */
window.renderBetCard = function(bet) {
    const time = bet.commence_time
        ? new Date(bet.commence_time).toLocaleString()
        : "Unknown time";

    const status = (bet.status || "").toLowerCase();

    const colors = {
        won: "#00ff88",
        lost: "#ff4444",
        active: "#00ccff",
        pending: "#00ccff",
        cancelled: "#ffaa00"
    };

    return `
        <div class="bet-card ${status}" style="margin-bottom: 12px; background: #1a1b23; padding: 15px; border-radius: 12px; border-left: 4px solid ${colors[status] || '#3b82f6'}; display: flex; justify-content: space-between; align-items: center;">
            <div class="bet-main-info">
                <span class="event-name" style="color: #9ca3af; font-size: 0.75rem; display: block; margin-bottom: 4px;">
                    ${bet.event || bet.market_name || bet.marketTitle || "Market Prediction"}
                </span>

                <span class="selection-text" style="color: white; font-size: 1.1rem; font-weight: bold; display: block; margin-bottom: 4px;">
                    Picked: ${bet.picked || bet.side} •
                    Stake: sKES ${bet.amount || bet.stake}
                </span>

                <span class="selection-text" style="color:#777">
                    📅 ${time}
                </span>
            </div>

            <div style="text-align:right;">
                <div class="bet-odds">
                    @${bet.odds || bet.price || "-"}
                </div>

                <small style="color:${colors[status] || "#888"}; font-weight:700;">
                    ${(bet.status || "UNKNOWN").toUpperCase()}
                </small>
            </div>
        </div>
    `;
}

function applyFilters(source) {
    let data = source || state.allMarkets;

    const active = (state.category || "all").toLowerCase();
    const search = (state.search || "").toLowerCase();

    let filtered = data.filter(m => {
        if (active === "all") return true;

        const cat = (m.category || "").toLowerCase();

        if (active === "football") {
            return cat === "football" || m.id?.startsWith("fb_");
        }

        if (active === "sports") {
            return cat === "sports" || cat === "football" || m.id?.startsWith("sp_") || m.id?.startsWith("fb_");
        }

        return cat === active;
    });

    if (search) {
        filtered = filtered.filter(m =>
            (m.title || "").toLowerCase().includes(search)
        );
    }

    return filtered;
}
const renderMatchCenter = (data) => {
    const { stats, lineups, events, predictions } = data;
    
    // 1. Live Events (Goals/Cards)
    const eventTimeline = events.map(e => `
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px; font-size:0.8rem;">
            <span style="color:#888; min-width:30px;">${e.time.elapsed}'</span>
            <span style="color:${e.type === 'Goal' ? '#00ff88' : '#ff4444'}">
                ${e.type === 'Goal' ? '⚽' : e.detail === 'Yellow Card' ? '🟨' : '🟥'}
            </span>
            <span>${e.player.name} (${e.team.name})</span>
        </div>
    `).join('') || '<p style="color:#444;">No major events yet.</p>';

    // 2. Win Probability (Predictions)
    const pred = predictions[0]?.predictions?.winner;
    const probHtml = pred ? `
        <div style="background:#1a1a1a; padding:10px; border-radius:6px; margin-bottom:15px; border-left:4px solid #00ff88;">
            <small style="color:#888; display:block; margin-bottom:4px;">WIN PROBABILITY</small>
            <div style="display:flex; justify-content:space-between; font-weight:bold; font-size:0.9rem;">
                <span>Home: ${pred.comment || 'N/A'}</span>
            </div>
        </div>
    ` : '';

    return `
        <div class="livescore-view">
            ${probHtml}
            <div style="margin-bottom:20px;">
                <h4 style="font-size:0.7rem; color:#888; text-transform:uppercase; margin-bottom:10px;">Match Timeline</h4>
                ${eventTimeline}
            </div>
            ${renderStatsBar(stats)} <!-- Existing possession bar logic -->
            <div style="margin-top:20px;">
                <h4 style="font-size:0.7rem; color:#888; text-transform:uppercase; margin-bottom:10px;">Starting XI</h4>
                ${renderLineups(lineups)}
            </div>
        </div>
    `;
};

function renderRelatedMatchNews(news = []) {
    if (!Array.isArray(news) || news.length === 0) {
        return `<div style="color:#777; font-size:0.85rem; margin-top:20px; padding:12px 14px; border:1px solid #222; border-radius:10px;">No related match news available.</div>`;
    }

    return `
        <div style="margin-top:20px; padding:14px; border:1px solid #222; border-radius:12px; background:#0f1117;">
            <h4 style="font-size:0.85rem; color:#00ff88; text-transform:uppercase; margin-bottom:14px;">Related Match News</h4>
            ${news.slice(0, 5).map(article => `
                <a href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer" style="display:block; margin-bottom:12px; text-decoration:none; color:#fff;">
                    <strong style="font-size:0.95rem; display:block; margin-bottom:6px;">${escapeHtml(article.title)}</strong>
                    <span style="color:#999; font-size:0.78rem;">${escapeHtml(article.source || 'Unknown source')} — ${escapeHtml(article.description || '').substring(0, 80)}...</span>
                </a>
            `).join('')}
        </div>
    `;
}

async function fetchMatchDetails(fixtureId) {
    try {
        const cleanId = fixtureId.replace('fb_', '');
        const response = await fetch(window.apiUrl ? window.apiUrl(`/api/football/details/${cleanId}`) : `/api/football/details/${cleanId}`);
        
        if (!response.ok) throw new Error('API request failed');
        
        return await response.json();
    } catch (e) {
        console.error("❌ Frontend Fetch Error:", e);
        return null;
    }
}


function requireAuth() {
    const authCard = document.querySelector('.auth-card');
    if (authCard) {
        authCard.scrollIntoView({ behavior: 'smooth' });
        authCard.classList.add('shake-highlight');
        setTimeout(() => authCard.classList.remove('shake-highlight'), 1000);
        return true;
    }
    return false;
}

async function openMarket(id, openInNewTab = false) {
    if (!localStorage.getItem("token")) {
        if (requireAuth()) return;
    }

    const m = window.marketMap?.[id];
    if (!m) return;

    // For news markets, optionally open in new page
    if (openInNewTab && m.category === 'news') {
        const newsUrl = `/news-detail.html?id=${encodeURIComponent(id)}`;
        window.open(newsUrl, '_blank');
        return;
    }

    const body = document.getElementById("modalBody");
    if (!body) return;
    
    localStorage.setItem("last_market_id", id);

    // Open Modal with smooth animation
    const modal = document.getElementById("richModal");
    modal.style.display = "flex";
    modal.classList.add("active");
    document.body.classList.add("modal-open");
    document.body.style.overflow = "hidden";
    
    // 1. Initial Render: UI structure + Betting Buttons
    body.innerHTML = m.category === 'news'
        ? renderNewsModal(m, renderMarketMedia(m))
        : renderDefaultModal(m, m.content || m.description, renderMarketMedia(m));

    // Add "Open in New Page" button for news
    if (m.category === 'news') {
        const newsHeader = body.querySelector('.story-mode');
        if (newsHeader) {
            const newPageBtn = document.createElement('button');
            newPageBtn.className = 'btn-open-new-page';
            newPageBtn.style.cssText = `
                display: inline-block;
                margin-top: 12px;
                padding: 8px 12px;
                background: rgba(0, 255, 136, 0.15);
                border: 1px solid rgba(0, 255, 136, 0.3);
                border-radius: 6px;
                color: #00ff88;
                font-size: 0.75rem;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s ease;
            `;
            newPageBtn.innerText = '🔗 Open Full Page';
            newPageBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                closeMarket();
                openMarket(id, true);
            };
            newsHeader.parentElement.insertBefore(newPageBtn, newsHeader.nextSibling);
        }
    }

    let centerContainer = document.getElementById("match-center-container");
    
    if (!centerContainer) {
        const newContainer = document.createElement('div');
        newContainer.id = "match-center-container";
        body.appendChild(newContainer);
        centerContainer = newContainer;
    }

    // 3. Live Football Data (Stats, Lineups, Ratings)
    if (m.category === "football" || id.startsWith("fb_")) {
        const statsLoader = document.createElement('div');
        statsLoader.innerHTML = `<div style="text-align:center; padding:15px; color:#666; font-size:0.75rem;">🔍 Scouting live data & ratings...</div>`;
        centerContainer.appendChild(statsLoader);

        try {
            const data = await fetchMatchDetails(id);
            statsLoader.remove();

            if (data && !data.error) {
                centerContainer.insertAdjacentHTML('beforeend', renderMatchCenter(data));
            } else if (data?.error?.includes('429')) {
                centerContainer.insertAdjacentHTML('beforeend', `<div style="color:#ffaa00; font-size:0.75rem; padding:10px; border:1px dashed #444;">Rate limit reached. Live ratings paused.</div>`);
            }
        } catch (err) {
            statsLoader.innerHTML = ""; 
            console.error("Match Center failed to load", err);
        }
    }
}
function closeMarket() {
    const modal = document.getElementById("richModal");
    const body = document.getElementById("modalBody");

    localStorage.removeItem("last_market_id");
    
    if (modal) {
        modal.classList.remove("active");
        modal.style.display = "none";
    }
    if (body) body.innerHTML = "";

    document.body.classList.remove("modal-open");
    document.body.style.overflow = "auto";
}
// Modal content is replaced dynamically, so delegate YES/NO clicks from the body.
document.getElementById("modalBody")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".bet-btn");
    if (!btn) return;

    e.stopPropagation();
    const id = btn.dataset.id;
    const choice = btn.dataset.choice;
    const title = btn.dataset.title || "Market";

    if (id && choice) {
        window.openBetModal(id, title, choice);
    }
});
/**
 * MODAL CONTENT
 */
function renderNewsModal(m, media = "") {
    const safeTitle = (m.betQuestion || m.title || "").replace(/'/g, "\\'");
    const storyContent = m.content || m.description || "The full story is being updated...";

    return `
        <div class="news-modal-content" style="padding:5px;">
            ${media}

            <h2 style="color:white; font-size: 1.5rem; font-weight: 900; margin: 20px 0 16px 0; line-height: 1.3;">
                ${escapeHtml(m.betQuestion || m.title)}
            </h2>

            <!-- 📖 ENHANCED STORY MODE -->
            <div class="story-mode" style="background: linear-gradient(135deg, rgba(0,255,136,0.05) 0%, rgba(0,200,100,0.02) 100%); border: 1px solid rgba(0,255,136,0.15); padding: 22px; border-radius: 12px; margin-bottom: 25px; line-height: 1.8; color: #e5e7eb;">
                <div style="color: #00ff88; font-size: 0.7rem; font-weight: 900; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 1.2px; display: flex; justify-content: space-between; align-items: center;">
                    <span>📰 Full Story</span>
                    <span style="background: rgba(0, 255, 136, 0.2); color: #00ff88; padding: 3px 8px; border-radius: 4px; font-size: 0.6rem;">LIVE</span>
                </div>
                <div style="font-size: 0.95rem; white-space: pre-wrap; word-break: break-word;">
                    ${linkify(escapeHtml(storyContent))}
                </div>
                ${m.url ? `
                <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid rgba(0,255,136,0.1); text-align: center;">
                    <a href="${escapeHtml(m.url)}" target="_blank" style="color: #00ff88; font-size: 0.8rem; text-decoration: none; font-weight: 700; display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; background: rgba(0,255,136,0.1); border-radius: 6px; transition: all 0.2s ease;">
                        📖 Read Original Story ↗
                    </a>
                </div>` : ''}
            </div>

            <!-- BETTING SECTION -->
            <div class="betting-section" style="margin-bottom: 25px;">
                <div style="color: #888; font-size: 0.7rem; font-weight: 700; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Place Your Prediction</div>
                <div class="betting-row" style="display:flex; gap:12px; margin-bottom: 0;">
                    <button class="bet-btn btn-yes" style="flex:1; padding: 18px; font-weight: 800; font-size: 1rem; background: linear-gradient(135deg, rgba(0,255,136,0.2) 0%, rgba(0,200,100,0.1) 100%); border: 1px solid rgba(0,255,136,0.4); color: #00ff88; border-radius: 10px; cursor: pointer; transition: all 0.2s ease;"
                        onclick="openBetModal('${m.id}', '${safeTitle}', 'Yes')" onmouseover="this.style.background='linear-gradient(135deg, rgba(0,255,136,0.35) 0%, rgba(0,200,100,0.2) 100%)'; this.style.boxShadow='0 0 15px rgba(0,255,136,0.3)'" onmouseout="this.style.background='linear-gradient(135deg, rgba(0,255,136,0.2) 0%, rgba(0,200,100,0.1) 100%)'; this.style.boxShadow='none'">👍 YES</button>\n                    <button class="bet-btn btn-no" style="flex:1; padding: 18px; font-weight: 800; font-size: 1rem; background: linear-gradient(135deg, rgba(255,77,79,0.2) 0%, rgba(200,50,50,0.1) 100%); border: 1px solid rgba(255,77,79,0.4); color: #ff6b6b; border-radius: 10px; cursor: pointer; transition: all 0.2s ease;"
                        onclick="openBetModal('${m.id}', '${safeTitle}', 'No')" onmouseover="this.style.background='linear-gradient(135deg, rgba(255,77,79,0.35) 0%, rgba(200,50,50,0.2) 100%)'; this.style.boxShadow='0 0 15px rgba(255,77,79,0.3)'" onmouseout="this.style.background='linear-gradient(135deg, rgba(255,77,79,0.2) 0%, rgba(200,50,50,0.1) 100%)'; this.style.boxShadow='none'">👎 NO</button>
                </div>
            </div>

            ${renderProbabilityChart(m)}

            <div style="border-top: 1px solid rgba(0,255,136,0.1); padding-top: 18px; margin-top: 20px;">
                ${m.displayHeadline || m.title ? `<p style="color:#999; font-size: 0.85rem; margin-bottom: 18px; background: rgba(100,100,100,0.1); padding: 12px; border-left: 3px solid #00ff88; border-radius: 6px;">
                    <strong style="color:#00ff88;">Headline:</strong> ${escapeHtml(m.displayHeadline || m.title)}
                </p>` : ''}
                ${renderMarketLiveInfo(m)}
                ${renderResolutionInfo(m)}
            </div>

            <div id="match-center-container"></div>
        </div>

        <style>
            @keyframes pulse {
                0% { opacity: 1; transform: scale(1); }
                50% { opacity: 0.4; transform: scale(1.2); }
                100% { opacity: 1; transform: scale(1); }
            }
        </style>
    `;
}

function renderDefaultModal(m, info, media) {
    const safeTitle = (m.title || "").replace(/'/g, "\\'");
    const boostLabel = m.is_boosted ? `<div style="margin-top:10px; display:inline-block; padding:8px 12px; border-radius:999px; background: rgba(255,214,0,0.12); color:#ffd60a; border:1px solid rgba(255,214,0,0.2); font-size:0.75rem; font-weight:700;">Elite Boosted Market +10%</div>` : '';
    
    return `
        ${media}
        <h2 style="color:white; font-weight:800; margin-top: 15px;">${escapeHtml(m.title)}</h2>
        ${boostLabel}
        
        <div id="persona-transmission-container"></div>

        <div class="betting-row" style="display:flex; gap:10px; margin: 20px 0;">
            <button class="bet-btn btn-yes" style="flex:1" data-id="${m.id}" data-choice="Yes" data-title="${safeTitle}">
                YES ${m.oddsA ? `(${m.oddsA})` : ''}
            </button>
            <button class="bet-btn btn-no" style="flex:1" data-id="${m.id}" data-choice="No" data-title="${safeTitle}">
                NO ${m.oddsB ? `(${m.oddsB})` : ''}
            </button>
        </div>

        <div id="match-center-container"></div>

        <div style="margin-top: 25px;">
            ${renderMarketLiveInfo(m)}
            ${renderProbabilityChart(m)}
            <p style="color:#71767b; line-height:1.5; font-size: 0.9rem; margin-bottom: 20px;">${linkify(escapeHtml(info))}</p>
            ${m.url ? `<p style="color:#999; font-size:0.85rem; margin-top: 10px;">Source: <a href="${escapeHtml(m.url)}" target="_blank" rel="noopener noreferrer" style="color:#00ff88; text-decoration:none;">${escapeHtml(m.source || m.url)}</a></p>` : ''}
            ${renderResolutionInfo(m)}
        </div>
    `;
}

async function quickBet(id, choice, btn) {
    const card = btn.closest('.market-card');
    const amountInput = card.querySelector('.bet-amount');
    const stake = parseFloat(amountInput.value);

    if (isNaN(stake) || stake < 1) {
        alert("Please enter a valid stake (Min 1 sKES)");
        return;
    }

    try {
        const response = await window.placeBet(id, choice, stake);

        if (response) {
            if (typeof renderUserHistory === "function") {
                await renderUserHistory(); 
            }
            
            console.log("Bet successfully reflected in history.");
        }
    } catch (error) {
        console.error("Bet placement failed:", error);
    }
}
function handleOutsideClick(e) {
    const betModal = document.getElementById('bet-modal');
    if (betModal && betModal.style.display === 'flex') {
        if (e.target === betModal) {
            window.closeBetModal();
            return; 
        }
    }

    const historyCenter = document.getElementById('historyCenter');
    if (historyCenter && historyCenter.classList.contains('active')) {
        const historyWindow = historyCenter.querySelector('.history-window');
        if (e.target === historyCenter) {
            toggleHistory();
        }
    }

    const accountCenter = document.getElementById('accountCenter');
    const accountCard = document.querySelector(".account-card");

    if (accountCenter && accountCenter.style.display !== 'none') {
        if (e.target === accountCenter || (accountCard && !accountCard.contains(e.target))) {
            toggleAccountCenter();
        }
    }
}

window.handleOutsideClick = handleOutsideClick;

document.addEventListener("click", (e) => {
    const modal = document.getElementById('bet-modal');
    if (modal && modal.style.display === 'flex') return;

    const marketCard = e.target.closest(".market-card");
    if (marketCard && !e.target.closest(".bet-btn")) {
        const id = marketCard.dataset.id;
        if (id) openMarket(id);
    }

    const betBtn = e.target.closest(".bet-btn");
    if (betBtn) {
        const id = betBtn.dataset.id;
        const choice = betBtn.dataset.choice;
        const title = betBtn.dataset.title; // Make sure this is added to your HTML
        
        if (id && choice) {
            window.openBetModal(id, title || "New Bet", choice);
        }
    }
});

document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;

    const marketCard = e.target.closest?.(".market-card");
    if (!marketCard || e.target.closest(".bet-btn")) return;

    e.preventDefault();
    const id = marketCard.dataset.id;
    if (id) openMarket(id);
});

window.renderHistory = function() {
    // Target the specific list view inside the tab, not the whole container
    const container = document.getElementById("predictions-list-view") || 
                      document.getElementById("bet-container");
                      
    if (!container) return;

    const bets = window.allBets || [];
    if (!bets.length) {
        container.innerHTML = `<div class="empty-state">No predictions found...</div>`;
        return;
    }

   const filtered = bets.filter(bet => {
    const status = (bet.status || "").toLowerCase();

    if (window.state.currentHistoryTab === "active")
        return ["pending", "active", "open"].includes(status);

    if (window.state.currentHistoryTab === "won")
        return ["won", "win"].includes(status);

    if (window.state.currentHistoryTab === "lost")
        return ["lost", "lose"].includes(status);

    if (window.state.currentHistoryTab === "cancelled")
        return ["cancelled", "void"].includes(status);

    return true;
});

    if (!filtered.length) {
        container.innerHTML = `<div class="empty-state">No ${window.state.currentHistoryTab} bets</div>`;
        return;
    }

    container.innerHTML = filtered.map(renderBetCard).join("");
console.log("Statuses:", allBets.map(b => b.status));
}


let pendingBet = null;

window.openBetModal = function (marketId, title, pick) {
    if (!localStorage.getItem("token")) {
        if (requireAuth()) return;
    }

    pendingBet = {
        marketId,
        title: title || "Market",
        pick
    };

    const titleEl = document.getElementById('modal-market-title');
    const pickEl = document.getElementById('modal-pick-display');

    if (titleEl) titleEl.innerText = pendingBet.title;
    if (pickEl) pickEl.innerText = `Your Pick: ${pick}`;

    const input = document.getElementById('bet-amount-input');
    if (input) input.value = 10;

    const modal = document.getElementById('bet-modal');
    if (modal) modal.style.display = 'flex';
};
function closeBetModal() {
    const modal = document.getElementById("bet-modal");
    if (modal) modal.style.display = "none";
    pendingBet = null;
}
async function processConfirmedBet() {
    if (!pendingBet) {
        alert("No market selected");
        return;
    }

    const amountInput = document.getElementById('bet-amount-input');
    const amount = parseFloat(amountInput.value);

    if (!amount || amount <= 0) {
        alert("Please enter a valid amount");
        return;
    }

    const btn = document.getElementById('confirm-proceed-btn');
    btn.disabled = true;
    btn.innerText = "Placing Bet...";

    try {
        const response = await fetch(window.apiUrl ? window.apiUrl('/api/place-bet') : '/api/place-bet', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            },
            body: JSON.stringify({
                marketId: pendingBet.marketId,
                side: pendingBet.pick,
                amount: amount
            })
        });

        const result = await response.json();

        if (result.success) {
            alert("Bet Placed Successfully!");
            closeBetModal();

            if (typeof refreshBets === 'function') {
                refreshBets('active');
            }

            if (typeof fetchProfile === 'function') {
                fetchProfile();
            }

        } else {
            alert(result.message || "Failed to place bet");
        }

    } catch (err) {
        console.error("Bet error:", err);
        alert("Connection error. Try again.");
    } finally {
        btn.disabled = false;
        btn.innerText = "Proceed";
    }
}

function toggleHistory() {
    const el = document.getElementById("historyCenter");
    if (!el) return;

    const isOpening = !el.classList.contains("active");

    el.classList.toggle("active");

    if (isOpening) {
        loadHistory(); // 🔥 load fresh data
    }
}

function openHistory() {
    const el = document.getElementById("historyCenter");
    if (!el) return;

    el.classList.add("active");
}

function closeHistory() {
    const el = document.getElementById("historyCenter");
    if (!el) return;

    el.classList.remove("active");
}

window.toggleHistory = toggleHistory;
window.openHistory = openHistory;
window.closeHistory = closeHistory;

function closeModal() {
    closeMarket();
    closeBetModal();
}

window.closeBetModal = closeBetModal;
window.processConfirmedBet = processConfirmedBet;

/**
 * CLEANUP ON LOAD
 */
document.addEventListener('DOMContentLoaded', () => {
    const withdrawBtn = document.getElementById('confirmWithdrawBtn');
    if (withdrawBtn) {
        // Only attach if the element actually exists
        console.log("Withdrawal listener attached safely.");
    }
    if (window.API && typeof window.API.switchBetTab === 'function') {
        window.API.switchBetTab('active');
    } else if (typeof switchBetTab === 'function') {
        switchBetTab('active');
    }
});
async function loadMarketsFallback() {
    try {
        const res = await fetch(window.apiUrl ? window.apiUrl('/api/markets') : '/api/markets');
        const data = await res.json();

        const markets =
            data?.markets ||
            data?.data ||
            (Array.isArray(data) ? data : []);

        state.allMarkets = markets;
        state.filteredMarkets = markets;
        window.allMarketsSource = markets;
        syncMarketMap(markets);

        if (typeof renderFilteredMarkets === "function") {
            renderFilteredMarkets();
        }

        if (typeof renderTrending === "function") {
            renderTrending();
        }

    } catch (err) {
        console.error("Fallback market load failed:", err);
    }
}
async function loadGreeting() {
    const greetingEl = document.getElementById("greetingText");
    const metaEl = document.getElementById("greetingMeta");
    const wrapper = document.querySelector(".greeting-wrapper");

    // Time-based greeting
    const hour = Number(new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Nairobi",
        hour: "2-digit",
        hour12: false
    }).format(new Date()));
    let greeting = "Hello";

    if (hour < 12) greeting = "Good morning ☀️";
    else if (hour < 17) greeting = "Good afternoon 🌤️";
    else greeting = "Good evening 🌙";

    greetingEl.textContent = greeting;

    try {
        const position = await new Promise((resolve, reject) => {
            if (!navigator.geolocation) return reject(new Error("No geolocation"));
            navigator.geolocation.getCurrentPosition(resolve, reject, {
                enableHighAccuracy: true,
                timeout: 8000,
                maximumAge: 10 * 60 * 1000
            });
        });

        const { latitude, longitude } = position.coords;
        const contextRes = await fetch(window.apiUrl ? window.apiUrl(`/api/user/context?lat=${latitude}&lon=${longitude}`) : `/api/user/context?lat=${latitude}&lon=${longitude}`);
        const context = await contextRes.json();
        let gpsPlace = "";

        try {
            const reverseRes = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}`);
            const reverse = await reverseRes.json();
            gpsPlace = reverse.address?.city ||
                reverse.address?.town ||
                reverse.address?.suburb ||
                reverse.address?.county ||
                "";
        } catch {
            gpsPlace = "";
        }

        if (context?.city && context.city !== "Unknown") {
            const weather = context.temp && context.temp !== "--"
                ? ` • ${context.temp}°C • ${context.condition || "Current weather"}`
                : "";
            metaEl.textContent = `📍 ${gpsPlace || context.city}${context.country ? `, ${context.country}` : ""}${weather}`;
        } else {
            throw new Error("Server location unavailable");
        }

    } catch (e) {
        try {
            const contextRes = await fetch(window.apiUrl ? window.apiUrl("/api/user/context") : "/api/user/context");
            const context = await contextRes.json();
            if (context?.city) {
                const weather = context.temp && context.temp !== "--"
                    ? ` • ${context.temp}°C • ${context.condition || "Current weather"}`
                    : "";
                metaEl.textContent = `📍 ${context.city}${context.country ? `, ${context.country}` : ""}${weather}`;
            } else {
                throw new Error("Browser location unavailable");
            }
        } catch {
            const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Nairobi";
            metaEl.textContent = `📍 ${zone.replace("_", " ")}`;
        }
    }
    // 🔥 Trigger animation AFTER content is set
    setTimeout(() => {
        wrapper.classList.add("greeting-show");
    }, 50);
}
window.fetchMarkets = async function() {
    try {
        const [marketResponse, newsResponse] = await Promise.all([
            apiFetch('/api/markets'),
            apiFetch('/api/news/everything').catch(() => null)
        ]);

        const markets = marketResponse?.markets || [];
        const newsMarkets = Array.isArray(newsResponse?.articles) ? newsResponse.articles : [];

        const merged = [];
        const seenIds = new Set();

        for (const item of [...newsMarkets, ...markets]) {
            if (!item || !item.id) continue;
            if (seenIds.has(item.id)) continue;
            seenIds.add(item.id);
            merged.push(item);
        }

        state.allMarkets = merged;
        state.filteredMarkets = merged;
        window.allMarketsSource = merged;
        syncMarketMap(merged);

        renderApp();
        return { markets: merged };

    } catch (err) {
        console.error("❌ Elite Fetch failed:", err);
        return { markets: window.state.allMarkets || [] };
    }
}
