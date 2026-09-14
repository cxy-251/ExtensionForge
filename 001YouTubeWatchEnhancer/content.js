/*
 * YouTube 专用逻辑（content script，随页面自动注入，配套样式见 content.css）。
 *
 * 提供三项功能：
 *  1. 播放器网页全屏 —— 点击控制栏按钮，用 CSS 把当前播放器铺满视口，保留
 *     标签栏/地址栏；期间会把播放器临时挂到 body 顶层，规避 YouTube 宽屏重排
 *     造成的层叠/裁剪问题，退出时放回原位。
 *  2. 单视频循环 —— 控制栏循环按钮，开启后当前视频播完自动重播。
 *  3. 频道“全部播放” —— 频道视频页排序行旁一个按钮，把当前排序下已加载的
 *     可见视频制成播放列表（前 50 个）。
 */
(() => {
  "use strict";

  // ---------- 常量 ----------

  const BUTTON_ID = "yt-webpage-fullscreen-button";
  const BACKDROP_ID = "yt-webpage-fullscreen-backdrop";
  const ACTIVE_CLASS = "yt-webpage-fullscreen-active";
  const NATIVE_CLASS = "yt-webpage-native-fullscreen";
  const PLAYER_ATTRIBUTE = "data-yt-webpage-fullscreen-player";
  const ANCESTOR_ATTRIBUTE = "data-yt-webpage-fullscreen-ancestor";
  const LEGACY_SIBLING_ATTRIBUTE = "data-yt-webpage-fullscreen-sibling";

  const TIMING = Object.freeze({
    discoveryDelay: 120,
    controlsDelay: 80,
    navigationDelay: 150,
    popstateDelay: 100,
    viewportDelay: 100,
    missingPlayerGrace: 1_500,
    healthInterval: 5_000
  });

  const ENTER_ICON = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path style="fill:none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        d="M9 3H3v6M15 3h6v6M9 21H3v-6M15 21h6v-6"/>
    </svg>`;

  const EXIT_ICON = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path style="fill:none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        d="M3 9h6V3M21 9h-6V3M3 15h6v6M21 15h-6v6"/>
    </svg>`;

  // ---------- 运行状态 ----------

  const state = {
    viewport: {
      active: false,
      player: null,
      ancestors: [],
      savedScrollX: 0,
      savedScrollY: 0,
      savedFocus: null
    },
    binding: {
      player: null,
      controlsRoot: null
    },
    observers: {
      discovery: null,
      controls: null
    },
    timers: {
      runtimeSync: 0,
      viewportRefresh: 0,
      healthCheck: 0
    },
    missingPlayerSince: 0
  };

  // ---------- 页面与播放器识别 ----------

  function getPageKind() {
    if (location.pathname === "/watch") return "watch";
    if (location.pathname.startsWith("/shorts/")) return "shorts";
    return "unsupported";
  }

  function getVisibleArea(element) {
    const rect = element.getBoundingClientRect();
    const width = Math.max(
      0,
      Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0)
    );
    const height = Math.max(
      0,
      Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)
    );
    return width * height;
  }

  function isRenderedPlayer(player) {
    if (!(player instanceof HTMLElement) || !player.isConnected) return false;

    const rect = player.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;

    const style = getComputedStyle(player);
    return style.display !== "none"
      && style.visibility !== "hidden"
      && Number(style.opacity || 1) > 0
      && Boolean(player.querySelector("video.html5-main-video, video"));
  }

  function scorePlayer(player, pageKind) {
    if (!isRenderedPlayer(player)) return -Infinity;

    const rect = player.getBoundingClientRect();
    const video = player.querySelector("video.html5-main-video, video");
    let score = getVisibleArea(player);

    if (video) {
      if (!video.paused && !video.ended) score += 1_000_000_000;
      if (video.currentTime > 0) score += 10_000_000;
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) score += 1_000_000;
    }

    if (pageKind === "watch") {
      const watchPage = player.closest("ytd-watch-flexy");
      if (watchPage && !watchPage.hasAttribute("hidden")) score += 100_000_000;
    }

    if (pageKind === "shorts") {
      const renderer = player.closest("ytd-reel-video-renderer");
      if (renderer?.matches("[is-active], [active]")) score += 500_000_000;
      if (renderer?.getAttribute("aria-hidden") === "false") score += 100_000_000;

      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const distanceFromViewportCenter = Math.hypot(
        centerX - window.innerWidth / 2,
        centerY - window.innerHeight / 2
      );
      score -= distanceFromViewportCenter * 1_000;
    }

    return score;
  }

  function findBestPlayer() {
    const pageKind = getPageKind();
    if (pageKind === "unsupported") return null;

    // 网页全屏期间优先保留当前播放器，避免响应式重排时切换到备用播放器。
    if (state.viewport.active && isRenderedPlayer(state.viewport.player)) {
      return state.viewport.player;
    }

    const selector = pageKind === "watch"
      ? "ytd-watch-flexy:not([hidden]) #movie_player, ytd-player #movie_player, #movie_player"
      : "ytd-reel-video-renderer #movie_player, #shorts-container #movie_player, #movie_player";

    return Array.from(document.querySelectorAll(selector))
      .map((player) => ({ player, score: scorePlayer(player, pageKind) }))
      .filter(({ score }) => Number.isFinite(score))
      .sort((left, right) => right.score - left.score)[0]?.player ?? null;
  }

  function findRightControls(player) {
    return player?.querySelector(".ytp-right-controls") ?? null;
  }

  // ---------- 网页全屏布局 ----------

  function clearLegacyMarkers() {
    document.querySelectorAll(`[${LEGACY_SIBLING_ATTRIBUTE}]`).forEach((element) => {
      element.removeAttribute(LEGACY_SIBLING_ATTRIBUTE);
    });
  }

  function ensureBackdrop() {
    let backdrop = document.getElementById(BACKDROP_ID);
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.id = BACKDROP_ID;
      backdrop.setAttribute("aria-hidden", "true");
    }

    const host = document.body ?? document.documentElement;
    if (backdrop.parentElement !== host) host.appendChild(backdrop);
    return backdrop;
  }

  function getPlayerAncestorPath(player) {
    const path = [];
    let parent = player?.parentElement ?? null;

    while (parent && parent !== document.documentElement) {
      path.push(parent);
      parent = parent.parentElement;
    }

    return path;
  }

  function isViewportLayoutCurrent(player) {
    const path = getPlayerAncestorPath(player);
    return state.viewport.player === player
      && player?.getAttribute(PLAYER_ATTRIBUTE) === "true"
      && path.length === state.viewport.ancestors.length
      && path.every((element, index) => (
        element === state.viewport.ancestors[index]
        && element.getAttribute(ANCESTOR_ATTRIBUTE) === "true"
      ));
  }

  function clearViewportLayout({ removeBackdrop = true, restorePlayer = true } = {}) {
    const player = state.viewport.player;
    if (player) {
      player.removeAttribute(PLAYER_ATTRIBUTE);
    }

    // 若全屏期间把播放器挪到了 body 顶层，退出时放回原位
    if (restorePlayer && state.viewport.home) {
      const home = state.viewport.home;
      const target = home.parent && home.parent.isConnected ? home.parent : null;
      if (target) {
        if (home.nextSibling && home.nextSibling.isConnected) {
          target.insertBefore(player, home.nextSibling);
        } else {
          target.appendChild(player);
        }
      }
    }
    state.viewport.home = null;

    for (const element of state.viewport.ancestors) {
      element.removeAttribute(ANCESTOR_ATTRIBUTE);
    }
    state.viewport.ancestors = [];

    if (removeBackdrop) document.getElementById(BACKDROP_ID)?.remove();
  }


  function applyViewportLayout(player) {
    clearViewportLayout({ removeBackdrop: false });

    // 全屏期间把播放器挪到 body 顶层（记住原位），摆脱宽屏祖先层叠/裁剪，
    // 确保它始终压在黑色遮罩之上，避免黑屏。
    if (player.parentElement !== document.body) {
      if (!state.viewport.home) {
        state.viewport.home = {
          parent: player.parentElement,
          nextSibling: player.nextSibling
        };
      }
      document.body.appendChild(player);
    }

    state.viewport.player = player;
    state.viewport.player.setAttribute(PLAYER_ATTRIBUTE, "true");

    state.viewport.ancestors = getPlayerAncestorPath(player);
    for (const element of state.viewport.ancestors) {
      element.setAttribute(ANCESTOR_ATTRIBUTE, "true");
    }

    ensureBackdrop();
  }


  function requestPlayerResize() {
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    });
  }

  // ---------- 播放器按钮 ----------

  function updateViewportButton() {
    const button = document.getElementById(BUTTON_ID);
    if (!button) return;

    button.innerHTML = state.viewport.active ? EXIT_ICON : ENTER_ICON;
    button.title = state.viewport.active ? "退出网页全屏（Esc）" : "网页全屏";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(state.viewport.active));
  }

  function syncButtonMetrics(button, nativeButton) {
    const rect = nativeButton.getBoundingClientRect();
    if (rect.width > 0) {
      button.style.setProperty("--yt-vfs-button-width", `${rect.width}px`);
    }
    if (rect.height > 0) {
      button.style.setProperty("--yt-vfs-button-height", `${rect.height}px`);
    }
  }

  function removeViewportButton() {
    document.getElementById(BUTTON_ID)?.remove();
  }

  function createViewportButton(nativeButton) {
    const button = document.createElement("button");
    const nativeClasses = Array.from(nativeButton.classList)
      .filter((className) => className !== "ytp-fullscreen-button");

    button.id = BUTTON_ID;
    button.type = "button";
    button.className = nativeClasses.join(" ");
    button.classList.add("ytp-button");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleViewportFullscreen();
    });

    return button;
  }

  function ensureViewportButton(player) {
    const controls = findRightControls(player);
    const nativeButton = controls?.querySelector(".ytp-fullscreen-button") ?? null;
    const parent = nativeButton?.parentElement ?? null;
    if (!controls || !nativeButton || !parent || !parent.isConnected) return false;

    let button = document.getElementById(BUTTON_ID);
    if (!button || button.parentElement !== parent) {
      button?.remove();
      button = createViewportButton(nativeButton);
    }

    try {
      if (button.nextElementSibling !== nativeButton) {
        parent.insertBefore(button, nativeButton);
      }
    } catch (error) {
      console.warn("[YouTube 网页全屏] 播放器控件正在重建，稍后重试。", error);
      button.remove();
      scheduleRuntimeSync(TIMING.discoveryDelay);
      return false;
    }

    syncButtonMetrics(button, nativeButton);
    updateViewportButton();
    ensureLoopButtons(player, parent, nativeButton);
    return true;
  }


  // ---------- DOM 观察器 ----------

  function stopDiscoveryObserver() {
    state.observers.discovery?.disconnect();
    state.observers.discovery = null;
  }

  function startDiscoveryObserver() {
    if (state.observers.discovery || getPageKind() === "unsupported") return;

    const root = document.body ?? document.documentElement;
    state.observers.discovery = new MutationObserver(() => {
      scheduleRuntimeSync(TIMING.discoveryDelay);
    });
    state.observers.discovery.observe(root, { childList: true, subtree: true });
  }

  function stopControlsObserver() {
    state.observers.controls?.disconnect();
    state.observers.controls = null;
    state.binding.player = null;
    state.binding.controlsRoot = null;
  }

  function observePlayerControls(player) {
    const controls = findRightControls(player);
    const controlsRoot = player.querySelector(".ytp-chrome-bottom") ?? controls;

    if (
      state.binding.player === player
      && state.binding.controlsRoot === controlsRoot
      && controlsRoot?.isConnected
    ) {
      ensureViewportButton(player);
      return;
    }

    stopControlsObserver();
    state.binding.player = player;
    state.binding.controlsRoot = controlsRoot;

    if (controlsRoot) {
      state.observers.controls = new MutationObserver(() => {
        scheduleRuntimeSync(TIMING.controlsDelay);
      });
      state.observers.controls.observe(controlsRoot, { childList: true, subtree: true });
    }

    ensureViewportButton(player);
  }

  // ---------- 运行状态同步 ----------

  function resetRuntime({ exitViewport = false, removeButton = false } = {}) {
    state.missingPlayerSince = 0;
    stopDiscoveryObserver();
    stopControlsObserver();

    if (exitViewport && state.viewport.active) exitViewportFullscreen();
    if (removeButton) removeViewportButton();
  }

  function syncRuntimeState() {
    if (getPageKind() === "unsupported") {
      resetRuntime({ exitViewport: true, removeButton: true });
      return;
    }

    const player = findBestPlayer();
    if (!player) {
      if (!state.missingPlayerSince) state.missingPlayerSince = Date.now();
      stopControlsObserver();
      removeViewportButton();
      startDiscoveryObserver();

      // YouTube 切片时播放器会短暂消失，留出重建时间后再退出网页全屏。
      if (
        state.viewport.active
        && Date.now() - state.missingPlayerSince > TIMING.missingPlayerGrace
      ) {
        exitViewportFullscreen();
      }
      return;
    }

    state.missingPlayerSince = 0;
    // stopDiscoveryObserver();

    // 网页全屏期间持续监听页面结构：YouTube 重排/重建 #movie_player 时会丢掉
    // 我们打的属性，若不监听就停在黑屏，直到下次 resize 或 5s 心跳才恢复。
    if (state.viewport.active) {
      startDiscoveryObserver();
    } else {
      stopDiscoveryObserver();
    }

    if (state.viewport.active && !isViewportLayoutCurrent(player)) {
      applyViewportLayout(player);
      requestPlayerResize();
    }

    observePlayerControls(player);
  }

  function scheduleRuntimeSync(delay = TIMING.popstateDelay) {
    window.clearTimeout(state.timers.runtimeSync);
    state.timers.runtimeSync = window.setTimeout(syncRuntimeState, delay);
  }

  // function scheduleViewportLayoutRefresh() {
  //   window.clearTimeout(state.timers.viewportRefresh);
  //   state.timers.viewportRefresh = window.setTimeout(() => {
  //     const player = findBestPlayer();
  //     if (state.viewport.active && player) {
  //       applyViewportLayout(player);
  //       requestPlayerResize();
  //     }
  //     syncRuntimeState();
  //   }, TIMING.viewportDelay);
  // }
  //
  function scheduleViewportLayoutRefresh() {
    window.clearTimeout(state.timers.viewportRefresh);

    // YouTube 响应式重排是异步分多步的，窗口一变要多等几个节点再补一次，
    // 否则它重排完会把我们刚打的标记覆盖，导致黑屏。
    const delays = [TIMING.viewportDelay, 260, 520, 900, 1500];
    delays.forEach((delay) => {
      state.timers.viewportRefresh = window.setTimeout(() => {
        if (!state.viewport.active) return;
        const player = findBestPlayer();
        if (!player) return;
        if (!isViewportLayoutCurrent(player)) applyViewportLayout(player);
        requestPlayerResize();
      }, delay);
    });

    // 最后一轮后再做一次完整状态同步
    state.timers.viewportRefresh = window.setTimeout(() => {
      if (state.viewport.active) syncRuntimeState();
    }, 1900);
  }

  function startHealthCheck() {
    window.clearInterval(state.timers.healthCheck);
    state.timers.healthCheck = window.setInterval(() => {
      if (document.visibilityState === "visible") syncRuntimeState();
    }, TIMING.healthInterval);
  }

  function clearTimers() {
    window.clearTimeout(state.timers.runtimeSync);
    window.clearTimeout(state.timers.viewportRefresh);
    window.clearInterval(state.timers.healthCheck);
    state.timers.runtimeSync = 0;
    state.timers.viewportRefresh = 0;
    state.timers.healthCheck = 0;
  }

  // ---------- 网页全屏状态 ----------

  function enterViewportFullscreen() {
    const player = findBestPlayer();
    if (!player || state.viewport.active) return;

    state.viewport.savedScrollX = window.scrollX;
    state.viewport.savedScrollY = window.scrollY;
    state.viewport.savedFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    state.viewport.active = true;

    applyViewportLayout(player);
    document.documentElement.classList.add(ACTIVE_CLASS);
    document.documentElement.classList.toggle(
      NATIVE_CLASS,
      Boolean(document.fullscreenElement)
    );
    observePlayerControls(player);
    updateViewportButton();
    requestPlayerResize();
  }

  function exitViewportFullscreen() {
    if (!state.viewport.active) return;

    state.viewport.active = false;
    document.documentElement.classList.remove(ACTIVE_CLASS, NATIVE_CLASS);
    clearViewportLayout();
    state.viewport.player = null;
    updateViewportButton();
    requestPlayerResize();

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.scrollTo(state.viewport.savedScrollX, state.viewport.savedScrollY);
        if (state.viewport.savedFocus?.isConnected) {
          state.viewport.savedFocus.focus({ preventScroll: true });
        }
        state.viewport.savedFocus = null;
      });
    });
  }

  function toggleViewportFullscreen() {
    if (state.viewport.active) {
      exitViewportFullscreen();
    } else {
      enterViewportFullscreen();
    }
  }

  function hasOpenPlayerPopup() {
    const player = state.viewport.player;
    if (!player) return false;

    return Array.from(
      player.querySelectorAll(".ytp-popup, .ytp-contextmenu")
    ).some((popup) => {
      const style = getComputedStyle(popup);
      const rect = popup.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || 1) > 0
        && rect.width > 0
        && rect.height > 0;
    });
  }

  function syncNativeFullscreenState() {
    document.documentElement.classList.toggle(
      NATIVE_CLASS,
      Boolean(document.fullscreenElement)
    );

    if (state.viewport.active && !document.fullscreenElement) {
      const player = findBestPlayer();
      if (player && !isViewportLayoutCurrent(player)) applyViewportLayout(player);
      requestPlayerResize();
    }

    updateViewportButton();
  }

  // ---------- 事件与生命周期 ----------

  function handleKeydown(event) {
    if (
      event.key !== "Escape"
      || !state.viewport.active
      || document.fullscreenElement
      || hasOpenPlayerPopup()
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    exitViewportFullscreen();
  }

  function handleNavigationStart() {
    stopDiscoveryObserver();
    stopControlsObserver();
    scheduleRuntimeSync(0);
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "visible") scheduleRuntimeSync(0);
  }

  function handleWindowResize(event) {
    // requestPlayerResize() 派发的是合成事件，只处理用户真实调整窗口产生的 resize。
    if (event.isTrusted) scheduleViewportLayoutRefresh();
  }

  function handlePageHide() {
    clearTimers();
    stopDiscoveryObserver();
    stopControlsObserver();
    if (state.viewport.active) exitViewportFullscreen();
    removeViewportButton();
    clearLegacyMarkers();
  }

  // ---------- 播放器控制栏单视频循环功能 ----------

  const SINGLE_LOOP_BUTTON_ID = "yt-single-loop-button";

  const SINGLE_LOOP_ICON = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path style="fill:none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        d="M7 7h9a5 5 0 1 1 0 10H6M9 4 6 7l3 3M17 17H8a5 5 0 1 1 0-10h10M15 20l3-3-3-3"/>
    </svg>`;

  let isSingleLoopActive = false;

  function toggleSingleLoop(player) {
    isSingleLoopActive = !isSingleLoopActive;
    const video = player?.querySelector("video") || document.querySelector("video");
    if (video) {
      video.loop = isSingleLoopActive;
    }
    updateLoopButtonsState(player);
  }

  function updateLoopButtonsState(player) {
    const singleBtn = document.getElementById(SINGLE_LOOP_BUTTON_ID);
    if (singleBtn) {
      singleBtn.classList.toggle("yt-loop-active", isSingleLoopActive);
      singleBtn.title = isSingleLoopActive ? "单视频循环播放: 已开启" : "单视频循环播放: 已关闭";
      singleBtn.setAttribute("aria-label", singleBtn.title);
    }
  }

  function ensureLoopButtons(player, parent, nativeButton) {
    if (!parent || !nativeButton || !parent.isConnected) return;

    let singleBtn = document.getElementById(SINGLE_LOOP_BUTTON_ID);
    if (!singleBtn || singleBtn.parentElement !== parent) {
      singleBtn?.remove();
      singleBtn = document.createElement("button");
      singleBtn.id = SINGLE_LOOP_BUTTON_ID;
      singleBtn.type = "button";
      const nativeClasses = Array.from(nativeButton.classList).filter((c) => c !== "ytp-fullscreen-button");
      singleBtn.className = nativeClasses.join(" ");
      singleBtn.classList.add("ytp-button");
      singleBtn.innerHTML = SINGLE_LOOP_ICON;
      singleBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleSingleLoop(player);
      });
      parent.insertBefore(singleBtn, nativeButton);
    }
    syncButtonMetrics(singleBtn, nativeButton);

    const video = player?.querySelector("video") || document.querySelector("video");
    if (video && !video.hasAttribute("data-yt-loop-bound")) {
      video.setAttribute("data-yt-loop-bound", "true");
      video.addEventListener("ended", () => {
        if (isSingleLoopActive) {
          video.currentTime = 0;
          video.play().catch(() => {});
        }
      });
    }

    updateLoopButtonsState(player);
  }

  // ---------- 频道视频页全部播放功能 ----------

  const CHANNEL_PLAY_ALL_BUTTON_ID = "yt-channel-play-all-button";
  const PLAY_ICON = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8 5v14l11-7z"/>
    </svg>`;

  function isChannelVideosPage() {
    return (
      location.pathname.includes("/videos") ||
      location.pathname.endsWith("/videos") ||
      Boolean(document.querySelector("ytd-browse[page-subtype='channels'] ytd-feed-filter-chip-bar-renderer"))
    );
  }

  function getActiveFilterLabel() {
    // 新版频道排序行：chip-bar-view-model 内高亮的 tab
    const row = document.querySelector("ytd-rich-grid-renderer chip-bar-view-model");
    const tab = row && row.querySelector('button[role="tab"][aria-selected="true"]');
    if (tab) {
      const text = tab.textContent.trim();
      if (text) return text;
    }
    // 旧版频道排序行：yt-chip-cloud-chip-renderer
    const oldChip = document.querySelector(
      "ytd-feed-filter-chip-bar-renderer yt-chip-cloud-chip-renderer[selected], " +
      "ytd-feed-filter-chip-bar-renderer yt-chip-cloud-chip-renderer[aria-selected='true'], " +
      "iron-selector#chips yt-chip-cloud-chip-renderer[selected]"
    );
    if (oldChip) {
      const text = oldChip.textContent.trim();
      if (text) return text;
    }
    return "当前列表";
  }

  function extractVisibleVideoIds() {
    const allLinks = Array.from(
      document.querySelectorAll("ytd-browse[page-subtype='channels'] a, ytd-rich-grid-renderer a, ytd-two-column-browse-results-renderer a, #primary a, a#video-title-link, a#thumbnail, a")
    );

    const videoIds = [];
    for (const link of allLinks) {
      if (link.closest("#masthead, #guide, #mini-guide, ytd-guide-renderer, ytd-mini-guide-renderer")) {
        continue;
      }

      const href = link.getAttribute("href") || link.href;
      if (!href) continue;

      let id = null;
      const watchMatch = href.match(/[?&]v=([^&]+)/);
      if (watchMatch && watchMatch[1]) {
        id = watchMatch[1];
      } else {
        const shortsMatch = href.match(/\/shorts\/([^/?&#]+)/);
        if (shortsMatch && shortsMatch[1]) {
          id = shortsMatch[1];
        }
      }

      if (id && !videoIds.includes(id)) {
        videoIds.push(id);
      }
    }

    return videoIds;
  }

  function handlePlayAllClick(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    const videoIds = extractVisibleVideoIds();
    if (videoIds.length === 0) {
      alert("未在当前页面检测到视频，请等待列表加载或向下滚动加载更多视频后再试！");
      return;
    }

    const targetIds = videoIds.slice(0, 50).join(",");
    window.location.href = `https://www.youtube.com/watch_videos?video_ids=${targetIds}`;
  }

  // 定位频道视频页的排序行容器（兼容新版 chip-bar 与旧版 feed-filter-chip-bar）
  function getChannelChipRow() {
    return (
      document.querySelector("ytd-rich-grid-renderer chip-bar-view-model") ||
      document.querySelector("ytd-feed-filter-chip-bar-renderer")
    );
  }

  // 排序行里的"胶囊"项（新版为 chip wrapper，旧版为 chip-renderer）
  function getChannelChipItems(row) {
    if (!row) return [];
    return Array.from(
      row.querySelectorAll(".ytChipBarViewModelChipWrapper, yt-chip-cloud-chip-renderer")
    );
  }

  function ensureChannelPlayAllButton() {
    if (!isChannelVideosPage()) {
      const b = document.getElementById(CHANNEL_PLAY_ALL_BUTTON_ID);
      if (b) b.remove();
      return;
    }

    const row = getChannelChipRow();
    const items = getChannelChipItems(row);
    // 排序行还没渲染出来时先不动，等下一次轮询
    if (items.length === 0) {
      const b = document.getElementById(CHANNEL_PLAY_ALL_BUTTON_ID);
      if (b) b.remove();
      return;
    }

    const lastChip = items[items.length - 1];
    let button = document.getElementById(CHANNEL_PLAY_ALL_BUTTON_ID);

    if (!button) {
      button = document.createElement("button");
      button.id = CHANNEL_PLAY_ALL_BUTTON_ID;
      button.type = "button";
      button.innerHTML = PLAY_ICON;
      button.addEventListener("click", handlePlayAllClick);
    }

    // 位置不对时插到最后一个胶囊右侧（随胶囊一起排布）
    const isPlaced = button.isConnected && button.previousElementSibling === lastChip;
    if (!isPlaced) {
      lastChip.after(button);
    }

    const filterName = getActiveFilterLabel();
    const tooltip = `全部播放当前列表 (${filterName}，前50部)`;
    if (button.title !== tooltip) {
      button.title = tooltip;
      button.setAttribute("aria-label", tooltip);
    }
  }

  function registerEventListeners() {
    document.addEventListener("keydown", handleKeydown, true);
    document.addEventListener("fullscreenchange", syncNativeFullscreenState);
    document.addEventListener("yt-navigate-start", handleNavigationStart);
    document.addEventListener("yt-navigate-finish", () => {
      scheduleRuntimeSync(TIMING.navigationDelay);
      setTimeout(ensureChannelPlayAllButton, 200);
      setTimeout(ensureChannelPlayAllButton, 600);
      setTimeout(ensureChannelPlayAllButton, 1200);
      setTimeout(ensureChannelPlayAllButton, 2500);
    });
    document.addEventListener("visibilitychange", handleVisibilityChange);

    window.addEventListener("resize", handleWindowResize);
    window.addEventListener("popstate", () => {
      scheduleRuntimeSync(TIMING.popstateDelay);
      setTimeout(ensureChannelPlayAllButton, 200);
      setTimeout(ensureChannelPlayAllButton, 800);
    });
    window.addEventListener("pagehide", handlePageHide, { once: true });

    document.addEventListener("click", (e) => {
      if (e.target && e.target.closest("yt-chip-cloud-chip-renderer, ytd-tab-renderer")) {
        setTimeout(ensureChannelPlayAllButton, 200);
        setTimeout(ensureChannelPlayAllButton, 600);
        setTimeout(ensureChannelPlayAllButton, 1200);
      }
    }, true);
  }

  // ---------- 启动 ----------

  function initialize() {
    clearLegacyMarkers();
    registerEventListeners();
    startHealthCheck();
    syncRuntimeState();
    setInterval(ensureChannelPlayAllButton, 500);
  }

  initialize();
})();
