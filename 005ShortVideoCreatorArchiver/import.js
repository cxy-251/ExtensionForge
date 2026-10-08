/*
 * 从磁盘重建去重记录。005 是新扩展，读不到 002/003/004 的 chrome.storage，
 * 但它们下过的东西在磁盘上有两样证据：
 *   1. 每个作者文件夹里的 downloaded.txt（"<platform> <id>" 一行一条）；
 *   2. 文件名本身：视频 "日期_标题_<id>.mp4"，图集文件夹 "日期_标题_<id>/"。
 * 两样都读，并成 dl:<platform>:<id> 和 arc:<platform>:<author>。
 *
 * arc: 一定要并进去：005 写 downloaded.txt 是用 arc: 整份覆盖，旧 id 不在 arc: 里就会被冲掉。
 *
 * 用 showDirectoryPicker 而不是 <input webkitdirectory>：后者 Chrome 会提示"将 N 个文件
 * 上传到此网站"（其实什么都不上传，只是固定措辞），而且要先把几万个文件全列完才回调。
 * 这里边遍历边处理，只读 downloaded.txt 的内容，其它文件只看名字。
 */
"use strict";

const $ = (id) => document.getElementById(id);
const LABELS = { kuaishou: "快手", douyin: "抖音", tiktok: "TikTok", xiaohongshu: "小红书" };
// 抖音 / TikTok 的作品 id 是 19 位左右的纯数字；快手是 3x 开头的字母数字串；小红书是 24 位十六进制
const ID_RE = { douyin: /^\d{15,}$/, tiktok: /^\d{15,}$/, kuaishou: /^[0-9a-z]{10,}$/i, xiaohongshu: /^[0-9a-f]{24}$/i };

async function allKeys() {
  return chrome.storage.local.getKeys
    ? chrome.storage.local.getKeys()
    : Object.keys(await chrome.storage.local.get(null));
}

async function showHave() {
  const p = $("platform").value;
  const keys = await allKeys();
  const n = keys.filter((k) => k.startsWith("dl:" + p + ":")).length;
  const a = keys.filter((k) => k.startsWith("arc:" + p + ":")).length;
  $("have").textContent = `当前已有 ${LABELS[p]} 记录：${n} 条（${a} 位作者）`;
}

// "日期_标题_<id>"（可能带 Chrome 重名时加的 " (1)"）→ id
function idFromName(name, platform) {
  const stem = name.replace(/\.[^.\/]+$/, "").replace(/ \(\d+\)$/, "");
  const last = stem.slice(stem.lastIndexOf("_") + 1);
  return ID_RE[platform].test(last) ? last : "";
}

// 作者按文件自己的位置认，不管选的是哪一层、媒体库怎么分层：
// downloaded.txt / 视频文件 → 所在文件夹；图集图片 → 上上级（上一级是 "日期_标题_<id>"）
function folderAt(parts, up) {
  return parts.length > up ? parts[parts.length - 1 - up] : "";
}

// 递归遍历文件夹，对每个文件回调 (name, parts, handle)；parts 是从所选文件夹开始的相对路径
async function walk(dir, parts, onFile) {
  for await (const [name, h] of dir.entries()) {
    if (h.kind === "directory") await walk(h, parts.concat(name), onFile);
    else await onFile(name, parts.concat(name), h);
  }
}

async function importDir(dir) {
  const platform = $("platform").value;
  const byAuthor = new Map();      // author -> Set<id>
  let scanned = 0, txtN = 0, fromTxt = 0, fromName = 0;
  const add = (author, id) => {
    if (!byAuthor.has(author)) byAuthor.set(author, new Set());
    byAuthor.get(author).add(id);
  };

  $("result").textContent = "扫描中…";
  await walk(dir, [dir.name], async (name, parts, handle) => {
    if (++scanned % 1000 === 0) $("result").textContent = `扫描中… 已看过 ${scanned} 个文件`;
    if (name === "downloaded.txt") {
      const author = folderAt(parts, 1);
      if (!author) return;
      txtN++;
      const text = await (await handle.getFile()).text();
      for (const line of text.split(/\r?\n/)) {
        const m = line.trim().match(/^(\S+)\s+(\S+)$/);
        if (m && m[1].toLowerCase() === platform) { add(author, m[2]); fromTxt++; }
      }
      return;
    }
    // 视频：id 在文件名里；图集：图片叫 01.jpg，id 在上一级文件夹名里
    let id = idFromName(name, platform), author = folderAt(parts, 1);
    if (!id) { id = idFromName(folderAt(parts, 1) + ".x", platform); author = folderAt(parts, 2); }
    if (id && author) { add(author, id); fromName++; }
  });

  const existing = new Set(await allKeys());
  const now = Date.now();
  let patch = {}, newIds = 0, total = 0;
  const flush = async () => {
    if (Object.keys(patch).length) await chrome.storage.local.set(patch);
    patch = {};
  };
  for (const [author, ids] of byAuthor) {
    const ak = "arc:" + platform + ":" + author;
    const got = await chrome.storage.local.get(ak);
    const merged = new Set(Array.isArray(got[ak]) ? got[ak] : []);
    for (const id of ids) {
      merged.add(id);
      total++;
      const k = "dl:" + platform + ":" + id;
      if (!existing.has(k)) { existing.add(k); patch[k] = now; newIds++; }
    }
    patch[ak] = [...merged];
    if (Object.keys(patch).length >= 2000) await flush();
  }
  await flush();

  $("result").textContent =
    `「${dir.name}」完成：扫描 ${scanned} 个文件，${byAuthor.size} 位作者、${total} 个作品（downloaded.txt ${txtN} 份 / ${fromTxt} 行，文件名识别 ${fromName} 个），` +
    `新增去重记录 ${newIds} 条。`;
  showHave();
}

$("platform").addEventListener("change", showHave);
let busy = false;
$("pick").addEventListener("click", async () => {
  if (busy) return;
  let dir;
  try { dir = await window.showDirectoryPicker({ mode: "read" }); } catch (_) { return; }   // 用户取消
  busy = true;
  $("pick").disabled = true;
  try { await importDir(dir); }
  catch (err) { $("result").textContent = "导入失败：" + err; }
  finally { busy = false; $("pick").disabled = false; }
});
showHave();
