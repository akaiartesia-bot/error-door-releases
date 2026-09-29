import {
  CATEGORY_LABELS,
  applyAuthorizationState,
  escapeHTML,
  extractImageWatermark,
  flattenBundles,
  isPng,
  maskEmail,
  parseRed,
  queryHistory,
  resolveWatermarkToken,
  tokenId,
  validateRegistry,
  verifyLicenseCodeLocal,
  watermarkCategory,
} from "./core.mjs";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const DB_NAME = "error-door-mobile";
const DB_VERSION = 1;
const STORE_NAME = "distribution-records";

let selectedRed = null;
let deferredInstall = null;
const bundles = new Map();

function showNotice(element, message, kind = "") {
  element.textContent = message;
  element.className = `notice${kind ? ` ${kind}` : ""}`;
  element.hidden = false;
}

function hideNotice(element) {
  element.hidden = true;
  element.textContent = "";
}

function setView(name, updateHash = true) {
  const selected = $( `.view[data-view="${name}"]` ) ? name : "home";
  $$(".view").forEach(view => {
    const active = view.dataset.view === selected;
    view.hidden = !active;
    view.classList.toggle("active", active);
  });
  $$("[data-tab]").forEach(button => button.classList.toggle("active", button.dataset.tab === selected));
  if (updateHash) history.replaceState(null, "", selected === "home" ? location.pathname : `#${selected}`);
  window.scrollTo({ top: 0, behavior: "instant" });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbTransaction(mode, action) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      const request = action(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

const loadSavedBundles = () => dbTransaction("readonly", store => store.getAll());
const saveBundle = bundle => dbTransaction("readwrite", store => store.put(bundle));
const clearSavedBundles = () => dbTransaction("readwrite", store => store.clear());

function updateRecordSummary() {
  const rows = flattenBundles([...bundles.values()]);
  $("#recordBundleCount").textContent = `${bundles.size} 份`;
  $("#recordItemCount").textContent = `${rows.length} 条`;
  $("#verifyRecordHint").textContent = bundles.size ? `已载入 ${bundles.size} 份记录` : "未导入记录";
  $("#historyRecordHint").textContent = bundles.size ? `${bundles.size} 份 · ${rows.length} 条可查询` : "尚未导入";
}

async function importRecordFiles(files) {
  const retain = $("#retainRecords").checked;
  let imported = 0;
  const errors = [];
  for (const file of files) {
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error("文件超过 8 MB");
      const text = await file.text();
      const registry = validateRegistry(JSON.parse(text));
      const id = `${registry.format}:${await tokenId(text)}`;
      const bundle = { id, name: file.name, importedAt: new Date().toISOString(), registry };
      bundles.set(id, bundle);
      if (retain) await saveBundle(bundle);
      imported += 1;
    } catch (error) {
      errors.push(`${file.name}：${error instanceof Error ? error.message : "无法读取"}`);
    }
  }
  updateRecordSummary();
  const notice = $("#historyNotice");
  if (errors.length) showNotice(notice, `已导入 ${imported} 份；${errors.length} 份失败。\n${errors.join("\n")}`, imported ? "warn" : "bad");
  else showNotice(notice, `已导入 ${imported} 份分发记录${retain ? "，并保留在这台手机" : "，仅供当前页面使用"}。`, "good");
}

function recordCardsForHits(hits) {
  const groups = new Map();
  for (const hit of hits) {
    let key;
    let title;
    let record = null;
    if (hit.mark.type === "qq") {
      key = `qq:${hit.mark.qq}`;
      title = hit.mark.qq;
    } else {
      record = resolveWatermarkToken(hit.mark.token, [...bundles.values()]);
      key = record ? `qq:${record.qq}` : `token:${hit.mark.token}`;
      title = record ? String(record.qq) : "匿名来源标识";
    }
    if (!groups.has(key)) groups.set(key, { title, record, hits: [] });
    const group = groups.get(key);
    if (!group.record && record) group.record = record;
    group.hits.push(hit);
  }
  return [...groups.values()];
}

async function renderVerifyResults(hits) {
  const container = $("#verifyResults");
  const groups = recordCardsForHits(hits);
  const cards = [];
  for (const group of groups) {
    const firstToken = group.hits.find(hit => hit.mark.type === "token")?.mark.token;
    const identity = group.record
      ? `<h3 class="mono">${escapeHTML(group.record.qq)}</h3><p>${escapeHTML(group.record.label || "未填写备注")}${group.record.email ? ` · ${escapeHTML(maskEmail(group.record.email))}` : ""}</p>`
      : group.hits[0].mark.type === "qq"
        ? `<h3 class="mono">${escapeHTML(group.title)}</h3><p>旧版直接 QQ 水印</p>`
        : `<h3>${escapeHTML(group.title)}</h3><p>标识 ID：<span class="mono">${escapeHTML(await tokenId(firstToken))}</span><br>导入生成该文件时的分发记录即可还原 QQ。</p>`;
    const paths = group.hits.map(hit => `<li><b>${escapeHTML(CATEGORY_LABELS[hit.category] || CATEGORY_LABELS.other)}</b> · ${escapeHTML(hit.path)}</li>`).join("");
    const copy = group.record || group.hits[0].mark.type === "qq"
      ? `<button class="copy-action" type="button" data-copy="${escapeHTML(group.title)}">复制 QQ</button>` : "";
    cards.push(`<article class="result-card"><div class="tagline"><span class="tag">${group.record ? "RESOLVED" : "WATERMARK"}</span><span class="count">命中 ${group.hits.length} 张图片</span></div>${identity}<ul class="path-list">${paths}</ul>${copy}</article>`);
  }
  container.innerHTML = cards.join("");
  container.querySelectorAll("[data-copy]").forEach(button => button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(button.dataset.copy);
    button.textContent = "已复制";
  }));
}

async function verifySelectedRed() {
  const notice = $("#verifyNotice");
  const progress = $("#verifyProgress");
  const button = $("#verifyButton");
  $("#verifyResults").innerHTML = "";
  if (!selectedRed) return showNotice(notice, "请先选择一个 RED 文件。", "bad");
  if (selectedRed.size > 300 * 1024 * 1024) return showNotice(notice, "文件超过 300 MB，不适合在手机浏览器中处理。", "bad");
  button.disabled = true;
  progress.hidden = false;
  showNotice(notice, "正在读取 RED 与图片资源，请保持页面在前台……");
  try {
    const parsed = await parseRed(new Uint8Array(await selectedRed.arrayBuffer()));
    const pngEntries = parsed.entries.filter(entry => isPng(entry.data));
    const hits = [];
    for (let index = 0; index < pngEntries.length; index += 1) {
      const entry = pngEntries[index];
      try {
        const mark = await extractImageWatermark(entry.data);
        if (mark) hits.push({ mark, path: entry.path, category: watermarkCategory(entry.path) });
      } catch { /* A damaged or unsupported image does not stop the remaining scan. */ }
      if (index % 3 === 0) {
        showNotice(notice, `正在扫描图片 ${index + 1} / ${pngEntries.length}……`);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    if (!hits.length) {
      showNotice(notice, `核验完成：扫描 ${pngEntries.length} 张 PNG，没有发现兼容的图片水印。`, "warn");
      return;
    }
    await renderVerifyResults(hits);
    const resolved = recordCardsForHits(hits).filter(group => group.record || group.hits[0].mark.type === "qq").length;
    showNotice(notice, `核验完成：命中 ${hits.length} 张图片，确认 ${resolved} 个来源。`, "good");
  } catch (error) {
    showNotice(notice, `核验失败：${error instanceof Error ? error.message : "无法读取文件"}`, "bad");
  } finally {
    button.disabled = false;
    progress.hidden = true;
  }
}

function historyCard(record) {
  const statusMap = { sent: "已发送", pending: "待发送", failed: "发送失败" };
  return `<article class="result-card"><div class="tagline"><span class="tag">${escapeHTML(record.short_id || String(record.fingerprint || "").slice(0, 12).toUpperCase())}</span><span class="count">${escapeHTML(statusMap[record.mail_status] || record.mail_status || "记录")}</span></div><h3>${escapeHTML(record.source_name || "未命名 RED")}</h3><p>${escapeHTML(record.created_at || "时间未记录")}<br>${escapeHTML(record.label || "未填写备注")}${record.package_file ? `<br>${escapeHTML(record.package_file)}` : ""}</p></article>`;
}

async function runHistoryQuery() {
  const notice = $("#historyNotice");
  const results = $("#historyResults");
  results.innerHTML = "";
  if (!bundles.size) return showNotice(notice, "请先导入桌面端生成的分发记录 JSON。", "bad");
  const button = $("#historyButton");
  button.disabled = true;
  showNotice(notice, "正在用核验密钥验证本机记录……");
  try {
    const report = await queryHistory($("#historyQQ").value, $("#historyKey").value, [...bundles.values()]);
    if (!report.matches.length) {
      const detail = report.candidateCount ? "找到该 QQ 的记录，但核验密钥不匹配。" : "导入的记录中没有这个 QQ。";
      showNotice(notice, detail, "warn");
      return;
    }
    results.innerHTML = report.matches.map(historyCard).join("");
    showNotice(notice, `已确认 ${report.matches.length} 条打标记录。`, "good");
  } catch (error) {
    showNotice(notice, error instanceof Error ? error.message : "查询失败", "bad");
  } finally { button.disabled = false; }
}

function licenseResultCard(result, online) {
  const payload = result.payload;
  const expiry = payload.exp || "永久";
  const hint = String(payload.lid || "").slice(-8) || "未提供";
  return `<article class="result-card"><div class="tagline"><span class="tag">${online ? "VERIFIED ONLINE" : "LOCAL SIGNATURE"}</span><span class="count">${online ? "停用状态已确认" : "未确认停用状态"}</span></div><h3>${payload.exp ? "授权有效" : "永久授权"}</h3><ul class="path-list"><li><b>授权 ID</b> · …${escapeHTML(hint)}</li><li><b>有效期</b> · ${escapeHTML(expiry)}</li><li><b>机器码</b> · ${escapeHTML(result.machine)}</li>${online ? `<li><b>状态版本</b> · ${escapeHTML(result.state.revision)}</li>` : ""}</ul></article>`;
}

async function checkLicense() {
  const notice = $("#licenseNotice");
  const resultBox = $("#licenseResult");
  const button = $("#licenseButton");
  resultBox.innerHTML = "";
  button.disabled = true;
  showNotice(notice, "正在核验授权签名……");
  try {
    const local = await verifyLicenseCodeLocal($("#licenseCode").value, $("#machineCode").value);
    try {
      const response = await fetch(`../license-state.json?r=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const verified = await applyAuthorizationState(local, await response.json());
      resultBox.innerHTML = licenseResultCard(verified, true);
      showNotice(notice, `授权有效，最近检查：${new Date().toLocaleString("zh-CN")}`, "good");
    } catch (networkError) {
      resultBox.innerHTML = licenseResultCard(local, false);
      showNotice(notice, `授权签名与有效期正确，但暂时无法确认在线停用状态。\n${networkError instanceof Error ? networkError.message : "网络不可用"}`, "warn");
    }
  } catch (error) {
    showNotice(notice, error instanceof Error ? error.message : "授权核验失败", "bad");
  } finally { button.disabled = false; }
}

function installInstructions() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const steps = ios
    ? ["使用 Safari 打开本页。", "点击浏览器底部的“分享”按钮。", "选择“添加到主屏幕”，再点击“添加”。"]
    : ["打开浏览器菜单。", "选择“安装应用”或“添加到主屏幕”。", "确认后即可从桌面打开。"];
  $("#installSteps").innerHTML = steps.map(step => `<li>${escapeHTML(step)}</li>`).join("");
  return ios;
}

async function requestInstall() {
  if (deferredInstall) {
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    return;
  }
  installInstructions();
  const dialog = $("#installDialog");
  if (typeof dialog.showModal === "function") dialog.showModal();
  else alert($("#installSteps").innerText);
}

function updateConnection() {
  const element = $("#connection");
  element.classList.toggle("offline", !navigator.onLine);
  element.querySelector("span").textContent = navigator.onLine ? "本机处理" : "离线可用";
}

async function init() {
  $$("[data-tab]").forEach(button => button.addEventListener("click", () => setView(button.dataset.tab)));
  $$("[data-go]").forEach(button => button.addEventListener("click", () => setView(button.dataset.go)));
  $$("[data-open-records]").forEach(button => button.addEventListener("click", () => $("#recordInput").click()));
  $("#recordInput").addEventListener("change", async event => {
    await importRecordFiles([...event.target.files]);
    event.target.value = "";
  });
  $("#redInput").addEventListener("change", event => {
    selectedRed = event.target.files[0] || null;
    $("#redPicker").classList.toggle("ready", Boolean(selectedRed));
    $("#verifyButton").disabled = !selectedRed;
    const selected = $("#selectedRed");
    selected.hidden = !selectedRed;
    selected.textContent = selectedRed ? `${selectedRed.name} · ${(selectedRed.size / 1_048_576).toFixed(2)} MB` : "";
    hideNotice($("#verifyNotice"));
  });
  $("#verifyButton").addEventListener("click", verifySelectedRed);
  $("#historyButton").addEventListener("click", runHistoryQuery);
  $("#licenseButton").addEventListener("click", checkLicense);
  $("#retainRecords").addEventListener("change", async event => {
    if (event.target.checked) {
      for (const bundle of bundles.values()) await saveBundle(bundle);
      if (bundles.size) showNotice($("#historyNotice"), "当前分发记录已保留在这台手机。", "good");
    } else {
      await clearSavedBundles();
      if (bundles.size) showNotice($("#historyNotice"), "已停止长期保留；当前页面关闭前仍可查询。", "warn");
    }
  });
  $("#clearRecords").addEventListener("click", async () => {
    await clearSavedBundles();
    bundles.clear();
    $("#retainRecords").checked = false;
    updateRecordSummary();
    $("#historyResults").innerHTML = "";
    $("#verifyResults").innerHTML = "";
    showNotice($("#historyNotice"), "这台手机上的分发记录已清除。", "good");
  });
  $("#installButton").addEventListener("click", requestInstall);
  $("#installRow").addEventListener("click", requestInstall);
  $$('[data-close-dialog]').forEach(button => button.addEventListener("click", () => $("#installDialog").close()));
  window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); deferredInstall = event; });
  window.addEventListener("online", updateConnection);
  window.addEventListener("offline", updateConnection);
  window.addEventListener("hashchange", () => {
    const requested = location.hash.replace(/^#/, "");
    if (["home", "verify", "history", "license", "more"].includes(requested)) setView(requested, false);
  });
  updateConnection();

  try {
    const saved = await loadSavedBundles();
    for (const bundle of saved) {
      try { validateRegistry(bundle.registry); bundles.set(bundle.id, bundle); }
      catch { /* Ignore invalid legacy browser data. */ }
    }
    $("#retainRecords").checked = bundles.size > 0;
  } catch { /* IndexedDB may be disabled in private browsing. */ }
  updateRecordSummary();

  const params = new URLSearchParams(location.search);
  const suppliedMachine = String(params.get("machine") || "").trim().toUpperCase();
  if (/^EDR-[A-Z0-9-]{10,40}$/.test(suppliedMachine)) $("#machineCode").value = suppliedMachine;
  const initial = location.hash.replace(/^#/, "");
  setView(["home", "verify", "history", "license", "more"].includes(initial) ? initial : "home", false);
  const ios = installInstructions();
  if (ios) {
    $("#installHint").textContent = "Safari 分享 → 添加到主屏幕";
    $("#installRowHint").textContent = "Safari 分享 → 添加到主屏幕";
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
}

init();
