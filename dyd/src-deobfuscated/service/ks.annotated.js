'use strict';
/* =========================================================================
 * KsService —— 快手采集 / 下载逻辑（人工整理注释版，非原始代码）
 * 原文件: resources/app.asar -> public/electron/service/ks.js （javascript-obfuscator 混淆）
 *
 * 【整体思路】
 *  这个工具不自己去逆快手的签名(__NS_sig3 / sig / kpn ...)。
 *  它开一个真正的 Electron BrowserWindow 打开 kuaishou.com，让【网页自己】发请求，
 *  再用 session.webRequest.onBeforeSendHeaders 在“请求发出前”截获
 *  URL + 请求头(含 Cookie) + POST body，然后用 axios 原样重放一遍拿到 JSON。
 *  所以：网页能加载出来 = 能采集；网页被风控/改接口 = 采集失效。
 * ========================================================================= */

const { Service } = require('ee-core');
const { app, dialog, BrowserWindow, session } = require('electron');
const axios = require('axios');
const common = require('../common');
const path = require('path');
const fs = require('fs');
const { download } = require('electron-dl');
const Services = require('ee-core/services');
const Addon = require('ee-core/addon');

class KsService extends Service {
  constructor(ctx) {
    super(ctx);
    this.isInterrupt = false;
    this.headers = [];   // 最近一次截获到的请求头（重放/兜底用）
    this.tasks = [];      // this.tasks[作品id] = { title, poster, urls:[下载直链...] }
  }

  /* 前端传入: { platform:'ks', type:'home'|'solo', url:'粘贴的快手链接' } */
  async openCollectionWindow(opt) {
    this.tasks = [];

    Services.get('collection').setListener({

      /* ---- 核心：请求发出前拦截 ---- */
      onBeforeSendHeaders: (win, details) => {
        // 给 Referer 加随机串，绕开重放请求命中缓存/去重
        if (details.requestHeaders.Referer) {
          details.requestHeaders.Referer +=
            '?r=' + Math.random().toString(16).substring(0, 6);
        }

        new Promise(async (resolve) => {

          // === 分支 A：主页作品列表 (type=home) —— GraphQL 翻页接口 ===
          //   命中条件：URL 含 "com/graphql" 且 POST body 含 "photoContent on PhotoEntity"
          if (
            opt.type === 'home' &&
            details.url.includes('com/graphql') &&
            details.uploadData &&
            details.uploadData[0].bytes.toString().includes('photoContent on PhotoEntity')
          ) {
            for (let i = 0; i < 5; i++) {
              try {
                delete details.requestHeaders['Accept-Encoding']; // 要未压缩的响应
                this.headers = details.requestHeaders;
                const resp = await axios.post(
                  details.url,
                  details.uploadData[0].bytes.toString(),
                  { headers: details.requestHeaders, timeout: 10000 }
                );
                // 期望结构: data.data.visionProfilePhotoList.feeds[]
                resp.data.data.visionProfilePhotoList.feeds
                  .forEach((feed) => this.handleFeed(feed, 101));
                break;
              } catch (e) { console.log(e); }
            }
          }

          // === 分支 B：单个作品 (type=solo) —— 直接抓网页里的 Apollo 缓存 ===
          //   命中条件：URL 含 "short-video" 或 "com/f/"
          else if (
            (opt.type === 'solo' && details.url.includes('short-video')) ||
            (opt.type === 'solo' && details.url.includes('com/f/'))
          ) {
            for (let i = 0; i < 10; i++) {
              try {
                const raw = await win.webContents.executeJavaScript(
                  'function getTest(){return JSON.stringify(window.__APOLLO_STATE__.defaultClient);}getTest();'
                );
                if (raw) {
                  const state = JSON.parse(raw);
                  let author = null, photo = null;
                  for (const k in state) {
                    if (k.includes('VisionVideoDetailAuthor')) author = state[k];
                    if (k.includes('VisionVideoDetailPhoto') && state[k].caption) photo = state[k];
                  }
                  if (author && photo) this.handleFeed({ feed: photo, author }, 102);
                }
                break;
              } catch (e) { console.log(e); }
              await common.sleep(1000);
            }
          }

          // === 分支 C：主页作品 (旧/移动端接口) —— GET profile/public? ===
          else if (opt.type === 'home' && details.url.includes('profile/public?')) {
            for (let i = 0; i < 5; i++) {
              try {
                delete details.requestHeaders['Accept-Encoding'];
                this.headers = details.requestHeaders;
                const resp = await axios.get(details.url,
                  { headers: details.requestHeaders, timeout: 10000 });
                resp.data.data.list.forEach((it) => this.handleFeed(it, 103));
                break;
              } catch (e) { console.log(e); }
            }
          }

          // === 分支 D：单作品 (移动端) —— GET profile/feedbyid?photoId= ===
          else if (opt.type === 'solo' && details.url.includes('profile/feedbyid?photoId')) {
            for (let i = 0; i < 5; i++) {
              try {
                delete details.requestHeaders['Accept-Encoding'];
                this.headers = details.requestHeaders;
                const resp = await axios.get(details.url,
                  { headers: details.requestHeaders, timeout: 10000 });
                this.handleFeed(resp.data.data.currentWork, 103);
                break;
              } catch (e) { console.log(e); }
            }
          }

          // === 分支 E：单作品 (分享域 chenzhongtech / photo/info) ===
          else if (
            opt.type === 'solo' &&
            details.url.includes('chenzhongtech') &&
            details.url.includes('photo/info')
          ) {
            for (let i = 0; i < 5; i++) {
              try {
                delete details.requestHeaders['Accept-Encoding'];
                this.headers = details.requestHeaders;
                const resp = await axios.post(
                  details.url, details.uploadData[0].bytes.toString(),
                  { headers: details.requestHeaders, timeout: 10000 });
                this.handleFeed(resp.data, 104); // 图集
                break;
              } catch (e) { console.log(e); }
            }
          }

          resolve();
        });
      },

      /* 页面加载完成后，往页面里塞几个提示浮层（红/蓝/黄字） */
      onDidFinishLoad: (win) => {
        win.webContents.executeJavaScript(/* 创建 #dydTip1/2/3 提示 div，见原文 */ '');
      },
    });

    Services.get('collection').open(opt.url); // 打开采集窗口，加载用户粘贴的 URL
  }

  /* ---- 下载：图集 ---- */
  async downloadI(job) {
    if (!this.tasks[job.task.id] || this.tasks[job.task.id].urls.length === 0) {
      common.noticeDownloadProgress(this.app, job, -999);
      return;
    }
    job.task.title = this.tasks[job.task.id].title;
    common.prepare(job, 'ks');
    Addon.get('axDownloader').download(this.tasks[job.task.id].urls, {
      outDir: job.outDir,
      skipDownloaded: true,
      nameFactory: (i) => job.settings.imageUseTit ? job.filterFileName + i + '.jpg' : i + '.jpg',
      onProgress: (p) => common.noticeDownloadProgress(this.app, job, p.rate, null),
    })
      .then((r) => common.noticeDownloadProgress(this.app, job, 100, r.outDir))
      .catch(() => common.noticeDownloadProgress(this.app, job, -999));
  }

  /* ---- 下载：视频（用 electron-dl，失败自动重试；优先 H265，其次普通 mp4）---- */
  async downloadV(job) {
    let url = this.tasks[job.task.id].urls.length > 0
      ? this.tasks[job.task.id].urls.splice(0, 1)[0] : null;
    if (!url) return common.noticeDownloadProgress(this.app, job, -999);

    if (this.tasks[job.task.id].title) job.task.title = this.tasks[job.task.id].title;
    common.prepare(job, 'ks');

    if (job.settings.poster) {
      Addon.get('axDownloader').download(this.tasks[job.task.id].poster,
        { outPath: job.absolutePath + '.jpg', skipDownloaded: true });
    }

    if (fs.existsSync(path.join(job.outDir, job.filterFileName + '.mp4'))) {
      common.noticeDownloadProgress(this.app, job, 100,
        path.join(job.outDir, job.filterFileName + '.mp4').toString());
    } else {
      download(this.app.mainWindow, url, {
        directory: job.outDir,
        filename: job.filterFileName + '.mp4',
        onStarted: (item) => this.downloadItem = item,
        onProgress: (p) => common.noticeDownloadProgress(this.app, job, parseInt(p.percent * 100)),
      })
        .then((di) => common.noticeDownloadProgress(this.app, job, 100, di.getSavePath()))
        .catch(async () => {
          if (this.isInterrupt) {
            this.tasks[job.task.id].urls.push(url);
            common.noticeDownloadProgress(this.app, job, -998, null, '下载失败：手动中止');
          } else {
            job.retryCounter = job.retryCounter || 1;
            common.noticeDownloadProgress(this.app, job, job.retryCounter++);
            this.downloadV(job); // 换下一条直链重试
          }
        });
    }
  }

  async interruptDownload(msg) {
    try {
      this.isInterrupt = msg.state;
      if (this.isInterrupt) {
        Addon.get('axDownloader').cancel();
        this.downloadItem.cancel();
      }
    } catch (e) {}
  }

  /* ---- 把不同接口返回的原始 feed 归一化成 task，并把可下载直链塞进 this.tasks ---- */
  handleFeed(item, kind) {
    try {
      if (kind === 101) {                 // 主页 GraphQL: item.photo / item.author
        const t = common.pkgTask(
          item.photo.duration ? 'video' : 'images',
          item.photo.id, item.photo.caption, item.author.name,
          item.photo.realLikeCount, 0, 0, item.photo.timestamp / 1000);
        this.tasks[t.id] = { title: t.title, poster: undefined, urls: [] };
        if (item.photo.duration) {
          this.tasks[t.id].poster = item.photo.coverUrl;
          if (item.photo.photoH265Url) this.tasks[t.id].urls.push(item.photo.photoH265Url);
          if (item.photo.photoUrl) this.tasks[t.id].urls.push(item.photo.photoUrl);
        }
        // 注意：kind 101 的“图集”分支是空的 —— 主页图文这里没实现取图 URL
        common.noticeCollectedTask(this.app, t);

      } else if (kind === 102) {          // 单作品 Apollo: item.feed / item.author
        const t = common.pkgTask(
          item.feed.duration ? 'video' : 'images',
          item.feed.id, item.feed.caption, item.author.name,
          item.feed.realLikeCount, 0, 0, item.feed.timestamp / 1000);
        this.tasks[t.id] = { title: t.title, poster: undefined, urls: [] };
        if (item.feed.duration) {
          this.tasks[t.id].poster = item.feed.coverUrl;
          if (item.feed.photoH265Url) this.tasks[t.id].urls.push(item.feed.photoH265Url);
          if (item.feed.photoUrl) this.tasks[t.id].urls.push(item.feed.photoUrl);
          common.noticeCollectedTask(this.app, t);
        }
        // 同样：单作品图文分支为空

      } else if (kind === 103) {          // 移动端 list / currentWork
        const t = common.pkgTask(
          item.imgUrls.length ? 'images' : 'video',
          item.id, '', item.author.name, item.counts.displayLike, 0, 0,
          Math.floor(Date.now() / 1000));
        this.tasks[t.id] = { title: t.title, poster: undefined, urls: [] };
        if (item.imgUrls.length) this.tasks[t.id].urls = item.imgUrls;
        else this.tasks[t.id].urls.push(item.playUrl);
        common.noticeCollectedTask(this.app, t);

      } else if (kind === 104) {          // chenzhongtech 图集
        if (item.atlas.list.length) {
          const base = 'https://' + item.atlas.cdn[0];
          const t = common.pkgTask('images', item.photo.photoId,
            item.shareInfo.shareTitle, item.photo.userName,
            item.counts.followCount, 0, 0, Math.floor(item.photo.timestamp / 1000));
          this.tasks[t.id] = {
            title: t.title, poster: undefined,
            urls: item.atlas.list.map((p) => base + p),
          };
          common.noticeCollectedTask(this.app, t);
        }
      }
    } catch (e) { console.log(e); }
  }
}

KsService.toString = () => '[class KsService]';
module.exports = KsService;
