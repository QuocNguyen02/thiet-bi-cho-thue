'use strict';

/* ======================================================================
   QUẢN LÝ THIẾT BỊ CHO THUÊ — giao diện
   Dữ liệu: 3 bảng trên cùng một Google Sheet
     devices   — danh mục thiết bị
     customers — khách hàng
     rentals   — đơn thuê (lưu toàn bộ lịch sử)
   ====================================================================== */

const RENTAL_STATUSES = ['Đặt trước', 'Đang thuê', 'Đã trả', 'Đã hủy'];
const ACTIVE = ['Đặt trước', 'Đang thuê'];
const DEVICE_STATES = ['Hoạt động', 'Bảo trì', 'Ngừng sử dụng'];
const RENTAL_CLASS = { 'Đặt trước': 's-res', 'Đang thuê': 's-rent', 'Đã trả': 's-ok', 'Đã hủy': 's-mnt' };
const TABLES = ['devices', 'customers', 'rentals'];

const KEYS = {
  devices: ['name', 'category', 'serial', 'price', 'state', 'note'],   // thiết bị dùng chung — không gắn chi nhánh
  customers: ['name', 'phone', 'idCard', 'address', 'note'],   // khách hàng dùng chung mọi chi nhánh
  rentals: ['status', 'branch', 'rentDate', 'returnDate', 'returnedDate', 'days', 'subtotal', 'discount', 'total', 'deposit', 'paid', 'note', 'items', 'itemsJson'],
};
const NUMERIC = ['price', 'days', 'subtotal', 'discount', 'total', 'deposit', 'paid'];
const DATES = ['rentDate', 'returnDate', 'returnedDate'];
const LABELS = {
  name: 'Tên', category: 'Loại', serial: 'Serial / Mã', branch: 'Chi nhánh', price: 'Giá thuê/ngày', state: 'Tình trạng',
  note: 'Ghi chú', phone: 'SĐT', idCard: 'CCCD', address: 'Địa chỉ', status: 'Trạng thái', rentDate: 'Ngày thuê',
  returnDate: 'Ngày trả dự kiến', returnedDate: 'Ngày trả thực tế', days: 'Số ngày', subtotal: 'Tạm tính', discount: 'Giảm giá',
  total: 'Thành tiền', deposit: 'Tiền cọc', paid: 'Thu trước', items: 'Thiết bị', itemsJson: 'Danh sách thiết bị',
  id: 'Mã', customerName: 'Khách hàng', updatedAt: 'Cập nhật lúc', updatedBy: 'Người cập nhật', createdAt: 'Tạo lúc',
};

/* ================== Cầu nối hệ thống ==================
   Trong app Electron: window.api (preload.js).
   Khi mở index.html bằng trình duyệt: dùng bản thay thế bên dưới. */
const sys = window.api || {
  getSettings: async () => readLS('tb.settings', {}),
  setSettings: async (s) => writeLS('tb.settings', s),
  getCache: async () => readLS('tb.cache2', null),
  setCache: async (c) => writeLS('tb.cache2', c),
  request: async ({ url, body }) => {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
      return await r.json();
    } catch (e) {
      return { ok: false, code: 'NETWORK', error: 'Không có mạng hoặc Google không phản hồi' };
    }
  },
  openExternal: async (url) => window.open(url, '_blank', 'noopener'),
  exportCsv: async (filename, content) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8' }));
    a.download = filename;
    a.click();
    return filename;
  },
  platform: 'web',
};
function readLS(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function writeLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* bỏ qua */ } }

/* ================== Trạng thái ================== */
const $ = (s) => document.querySelector(s);
const state = {
  settings: {},
  // Quyền do máy chủ quyết định theo mã bảo mật. Máy chủ bản cũ (2.0) → xem tất cả như trước.
  me: { branch: '', owner: true, legacy: true },
  branches: [],   // danh sách chi nhánh (BRANCH_KEYS trên máy chủ)
  data: { devices: [], customers: [], rentals: [] },
  since: '',
  sheetName: '',
  sheetUrl: '',
  lastSync: null,
  cacheAt: null,
  online: false,
  lastError: null,
  busy: 0,
  refreshing: false,
  view: 'rentals',
  period: 'active',
  month: '',
  vf: { rentals: { q: '', f1: '', f2: '' }, devices: { q: '', f1: '', f2: '' }, customers: { q: '', f1: '', f2: '' } },
  sort: { rentals: { key: 'rentDate', desc: true }, devices: { key: 'name', desc: false }, customers: { key: 'last', desc: true } },
  flash: new Set(),
  timer: null,
  idx: null,      // chỉ mục tính sẵn (thiết bị đang bận, lịch sử khách…)
  rf: null,       // trạng thái form đơn thuê đang mở
  df: null,       // form thiết bị
  cf: null,       // form khách hàng
};

/* ================== Tiện ích ================== */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fold = (v) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
const digits = (v) => String(v ?? '').replace(/\D/g, '');
const pad = (n) => String(n).padStart(2, '0');

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function thisMonth() { return todayISO().slice(0, 7); }
function toISODate(v) {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return '';
}
/* Giờ "HH:mm" trong chuỗi ngày ("2026-11-14 09:30") — '' nếu chỉ có ngày */
function timeOf(v) {
  const m = String(v ?? '').match(/^\d{4}-\d{1,2}-\d{1,2}[ T](\d{1,2}):(\d{2})/);
  return m ? `${pad(m[1])}:${m[2]}` : '';
}
function joinDT(date, time) { return date ? (time ? `${date} ${time}` : date) : ''; }
/* Mốc thời gian để so sánh: "yyyy-MM-dd HH:mm". Chỉ có ngày → đầu ngày (start) hoặc cuối ngày (end) */
function stamp(v, end = false) {
  const d = toISODate(v);
  if (!d) return '';
  return `${d} ${timeOf(v) || (end ? '23:59' : '00:00')}`;
}
function nowStamp() { const d = new Date(); return `${todayISO()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function nowTime() { return nowStamp().slice(11); }
/* Chuẩn hóa giờ người dùng gõ: "9" → 09:00, "930" → 09:30, "9h15" → 09:15; sai → '' */
function normTime(s) {
  s = String(s ?? '').trim().toLowerCase().replace(/h/g, ':').replace(/[^\d:]/g, '');
  if (!s) return '';
  let h, m;
  if (s.includes(':')) [h, m] = s.split(':');
  else if (s.length <= 2) [h, m] = [s, '0'];
  else [h, m] = [s.slice(0, -2), s.slice(-2)];
  h = Number(h); m = Number(m || 0);
  if (!(h >= 0 && h <= 23 && m >= 0 && m <= 59)) return '';
  return `${pad(h)}:${pad(m)}`;
}
function fmtDate(v, short = false) {
  const iso = toISODate(v);
  if (!iso) return esc(v);
  const [y, m, d] = iso.split('-');
  const t = timeOf(v);
  return (short ? `${d}/${m}` : `${d}/${m}/${y}`) + (t ? ' ' + t : '');
}
function fmtDateTime(v) {
  const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? `${m[4]}:${m[5]} ${m[3]}/${m[2]}/${m[1]}` : String(v ?? '');
}
function fmtMonth(ym) {
  const [y, m] = String(ym).split('-');
  return `Tháng ${Number(m)}/${y}`;
}
function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
function daysBetween(aISO, bISO) { return Math.round((Date.parse(bISO) - Date.parse(aISO)) / 86400000); }
function toNum(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (!s) return '';
  const n = Number(s.replace(/[^\d-]/g, ''));
  return isNaN(n) ? '' : n;
}
const n0 = (v) => Number(toNum(v)) || 0;
const fmtMoney = (v) => (toNum(v) === '' ? '' : toNum(v).toLocaleString('vi-VN') + ' đ');
const fmtShortMoney = (v) => {
  const n = n0(v);
  if (Math.abs(n) >= 1e9) return (n / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 2 }) + ' tỷ';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + ' tr';
  return n.toLocaleString('vi-VN') + ' đ';
};
function setMoney(input, v) {
  const n = toNum(v);
  input.value = n === '' ? '' : n.toLocaleString('vi-VN');
}
function parseItems(r) {
  try {
    const a = JSON.parse(r.itemsJson || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}
/* Đơn của chi nhánh khác: máy chủ chỉ gửi lịch bận (không có tiền) — chỉ dùng để biết thiết bị bận */
/* Điện thoại: không tự chọn sẵn ô nhập khi mở form (bàn phím sẽ bật lên che form) */
const isPhone = () => matchMedia('(max-width: 760px)').matches;
function autoFocus(el) { if (el && !isPhone()) el.focus(); }

const isOwn = (r) => !r.masked;
/* Doanh thu của đơn tính cho chi nhánh NHẬN đơn (cột Chi nhánh), không phải chi nhánh tạo hộ.
   Máy chi nhánh chỉ cộng các đơn của chính chi nhánh mình; chủ / máy chủ bản cũ: mọi đơn. */
const countsRevenue = (r) => state.me.owner || state.me.legacy || fold(r.branch) === fold(state.me.branch);
/* Đơn do chi nhánh khác tạo hộ (hoặc mình tạo hộ chi nhánh khác) */
const createdElsewhere = (r) => r.createdBranch && fold(r.createdBranch) !== fold(r.branch);
const myBranch = () => state.me.branch || state.settings.branch || '';
function setMe(res) {
  if (!res || res.branch === undefined) return;   // máy chủ bản cũ
  state.me = { branch: String(res.branch || ''), owner: !!res.owner, legacy: false };
  if (Array.isArray(res.branches)) state.branches = res.branches;
}
/* Các chi nhánh để chọn khi tạo đơn: theo máy chủ, cộng tên đã có trong dữ liệu (máy chủ bản cũ) */
function branchOptions(current = '') {
  const list = state.branches.length ? [...state.branches] : uniq('rentals', 'branch');
  if (!state.branches.length && state.settings.branch) list.push(state.settings.branch);
  if (current && !list.some((b) => fold(b) === fold(current))) list.push(current);
  return [...new Set(list)];
}

/* Nhãn phân biệt máy: serial, hoặc "Máy 2/3 · chưa có serial" */
function unitText(d) {
  if (d.serial) return d.serial;
  const u = state.idx && state.idx.unit.get(d.id);
  return [u, 'chưa có serial'].filter(Boolean).join(' · ');
}

function itemsText(items) {
  return items.map((i) => i.name + (i.serial ? ` (${i.serial})` : '')).join('; ');
}

/* Khoảng thời gian một đơn chiếm thiết bị */
function rentalRange(r) {
  const s = stamp(r.rentDate) || '0000-01-01 00:00';
  let e = stamp(r.returnedDate, true) || stamp(r.returnDate, true) || '9999-12-31 23:59';
  if (r.status === 'Đang thuê' && e < nowStamp()) e = nowStamp();   // quá hạn chưa trả: vẫn bận ít nhất tới bây giờ
  return [s, e < s ? s : e];
}
const overlaps = (a, b) => a[0] < b[1] && b[0] < a[1];   // trả lúc 10:00 và đơn sau nhận lúc 10:00 → không trùng

function isLate(r) {
  const ret = stamp(r.returnDate, true);
  return r.status === 'Đang thuê' && ret && ret < nowStamp();
}
/* Tiền cọc được trừ vào lần thanh toán cuối:
     Còn phải thu = Tiền thuê − Giảm giá − Tiền cọc − Thu trước
     Cọc + đã trả nhiều hơn thành tiền → phần dư trả lại khách. Đơn hủy: trả lại toàn bộ. */
const received = (r) => n0(r.deposit) + n0(r.paid);                                      // khách đã đưa (cọc + thu trước)
function due(r) { return r.status === 'Đã hủy' ? 0 : Math.max(0, n0(r.total) - received(r)); }
function refund(r) { return r.status === 'Đã hủy' ? received(r) : Math.max(0, received(r) - n0(r.total)); }
const rentPrice = (r) => n0(r.subtotal) || n0(r.total) + n0(r.discount);              // tiền thuê trước giảm giá
const collected = (r) => (r.status === 'Đã hủy' ? 0 : Math.min(n0(r.total), received(r)));  // phần tiền tính là đã thu
function rentalChip(r) {
  if (isLate(r)) return `<span class="chip s-late">Quá hạn</span>`;
  return `<span class="chip ${RENTAL_CLASS[r.status] || 's-mnt'}">${esc(r.status || '—')}</span>`;
}

/* ================== Chỉ mục tính sẵn ================== */
function buildIndex() {
  const busy = new Map();       // deviceId → [đơn đang hoạt động]
  const byDevice = new Map();   // deviceId → [mọi đơn]
  const byCustomer = new Map(); // customerId → [mọi đơn]
  for (const r of state.data.rentals) {
    const items = parseItems(r);
    r._items = items;
    const own = isOwn(r);
    for (const it of items) {
      if (own) {
        if (!byDevice.has(it.id)) byDevice.set(it.id, []);
        byDevice.get(it.id).push(r);
      }
      if (ACTIVE.includes(r.status)) {           // thiết bị dùng chung: bận ở chi nhánh nào cũng tính
        if (!busy.has(it.id)) busy.set(it.id, []);
        busy.get(it.id).push(r);
      }
    }
    if (own && r.customerId) {
      if (!byCustomer.has(r.customerId)) byCustomer.set(r.customerId, []);
      byCustomer.get(r.customerId).push(r);
    }
  }
  const sortDesc = (a, b) => String(b.rentDate).localeCompare(String(a.rentDate)) || String(b.id).localeCompare(String(a.id));
  byDevice.forEach((l) => l.sort(sortDesc));
  byCustomer.forEach((l) => l.sort(sortDesc));
  // máy cùng tên chưa có serial: đánh số "Máy 1/2, 2/2" theo thứ tự thêm vào để phân biệt
  const unit = new Map(), groups = new Map();
  [...state.data.devices].sort((a, b) => String(a.id).localeCompare(String(b.id))).forEach((d) => {
    const k = fold(d.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d.id);
  });
  groups.forEach((ids) => ids.forEach((id, i) => unit.set(id, ids.length > 1 ? `Máy ${i + 1}/${ids.length}` : '')));
  state.idx = { busy, byDevice, byCustomer, unit };
}

/** Tình trạng hiện tại của thiết bị (tính từ đơn thuê) */
function deviceStatus(d) {
  if (d.state === 'Ngừng sử dụng') return { key: 'Ngừng sử dụng', cls: 's-mnt', text: 'Ngừng sử dụng' };
  if (d.state === 'Bảo trì') return { key: 'Bảo trì', cls: 's-mnt', text: 'Bảo trì' };
  const list = state.idx.busy.get(d.id) || [];
  const renting = list.find((r) => r.status === 'Đang thuê');
  if (renting) {
    const late = isLate(renting);
    return { key: 'Đang cho thuê', cls: late ? 's-late' : 's-rent', text: late ? 'Quá hạn trả' : 'Đang cho thuê', rental: renting };
  }
  const booked = list.filter((r) => r.status === 'Đặt trước').sort((a, b) => String(a.rentDate).localeCompare(String(b.rentDate)))[0];
  if (booked) return { key: 'Đã đặt', cls: 's-res', text: 'Đã đặt ' + fmtDate(booked.rentDate, true), rental: booked };
  return { key: 'Sẵn sàng', cls: 's-ok', text: 'Sẵn sàng' };
}

function customerStats(c) {
  const list = (state.idx.byCustomer.get(c.id) || []).filter((r) => r.status !== 'Đã hủy');
  return {
    count: list.length,
    spent: list.filter(countsRevenue).reduce((s, r) => s + n0(r.total), 0),
    due: list.filter(countsRevenue).reduce((s, r) => s + due(r), 0),
    active: list.filter((r) => ACTIVE.includes(r.status)).length,
    last: list[0] ? toISODate(list[0].rentDate) : '',
    list: state.idx.byCustomer.get(c.id) || [],
  };
}

/* ================== Danh sách xổ xuống ==================
   macOS mở danh sách của <select> đè lên chính cái nút (mục đang chọn nằm đúng chỗ nút) nên trông như sai vị trí.
   Bản này luôn xổ ngay bên dưới nút (hoặc bên trên nếu sát đáy cửa sổ). <select> gốc vẫn giữ nhưng ẩn đi,
   nên form, .value và sự kiện "change" dùng như cũ. */
const NATIVE_VALUE = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
function closeDropdowns(except = null) {
  document.querySelectorAll('.dd').forEach((w) => w !== except && w._close && w._close());
}
function enhanceSelect(sel) {
  const wrap = document.createElement('div');
  wrap.className = 'dd';
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dd-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  const panel = document.createElement('div');
  panel.className = 'dd-panel hidden';
  panel.setAttribute('role', 'listbox');
  wrap.append(btn, panel);
  let hi = -1;
  const label = () => {
    const o = sel.options[sel.selectedIndex];
    btn.textContent = o ? o.textContent : '';
    btn.classList.toggle('placeholder', !o || o.value === '');
    btn.disabled = sel.disabled;
    btn.title = sel.title || '';
  };
  const draw = () => {
    panel.innerHTML = [...sel.options].map((o, i) =>
      `<div class="dd-opt ${i === sel.selectedIndex ? 'on' : ''} ${i === hi ? 'hl' : ''}" role="option" data-i="${i}">${esc(o.textContent)}</div>`).join('');
  };
  const place = () => {
    const r = btn.getBoundingClientRect();
    panel.style.minWidth = r.width + 'px';
    panel.style.left = r.left + 'px';
    const h = Math.min(panel.scrollHeight, 320);
    const below = window.innerHeight - r.bottom - 8;
    if (below < h && r.top > below) { panel.style.top = ''; panel.style.bottom = (window.innerHeight - r.top + 4) + 'px'; }
    else { panel.style.bottom = ''; panel.style.top = (r.bottom + 4) + 'px'; }
    const pr = panel.getBoundingClientRect();
    if (pr.right > window.innerWidth - 8) panel.style.left = Math.max(8, window.innerWidth - 8 - pr.width) + 'px';
  };
  const open = () => {
    if (sel.disabled) return;
    closeDropdowns(wrap);
    hi = sel.selectedIndex;
    draw();
    panel.classList.remove('hidden');
    place();
    btn.setAttribute('aria-expanded', 'true');
    const on = panel.querySelector('.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  };
  const close = () => { panel.classList.add('hidden'); btn.setAttribute('aria-expanded', 'false'); };
  const pick = (i) => {
    if (i < 0) return;
    const changed = sel.selectedIndex !== i;
    sel.selectedIndex = i;
    label();
    close();
    btn.focus();
    if (changed) sel.dispatchEvent(new Event('change', { bubbles: true }));
  };
  // Nút nằm trong <label>: Safari (iPhone) có thể "bấm hộ" lần nữa vào label → danh sách vừa mở đã đóng.
  // preventDefault chặn việc bấm hộ đó; thêm khóa 350ms cho chắc.
  let lastToggle = 0;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (Date.now() - lastToggle < 350) return;
    lastToggle = Date.now();
    if (panel.classList.contains('hidden')) open(); else close();
  });
  panel.addEventListener('mousedown', (e) => e.preventDefault());
  panel.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const o = e.target.closest('.dd-opt');
    if (o) pick(Number(o.dataset.i));
  });
  btn.addEventListener('keydown', (e) => {
    const isOpen = !panel.classList.contains('hidden');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) return open();
      const n = sel.options.length;
      hi = (hi + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      draw();
      const h = panel.querySelector('.hl');
      if (h) h.scrollIntoView({ block: 'nearest' });
    } else if ((e.key === 'Enter' || e.key === ' ') && isOpen) { e.preventDefault(); pick(hi); }
    else if (e.key === 'Escape' && isOpen) { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') close();
  });
  wrap._close = close;
  wrap._place = () => { if (!panel.classList.contains('hidden')) place(); };
  wrap._btn = btn;
  sel.focus = () => btn.focus();
  // code đổi giá trị / danh sách / khóa ô → cập nhật nút
  Object.defineProperty(sel, 'value', {
    configurable: true,
    get() { return NATIVE_VALUE.get.call(this); },
    set(v) { NATIVE_VALUE.set.call(this, v); label(); },
  });
  new MutationObserver(label).observe(sel, { childList: true, subtree: true, attributes: true });
  sel.form && sel.form.addEventListener('reset', () => setTimeout(label));
  label();
}
document.addEventListener('mousedown', (e) => { if (!e.target.closest('.dd')) closeDropdowns(); });
// cuộn trang / đổi cỡ cửa sổ (iPhone: thanh địa chỉ co giãn khi chạm) → danh sách đi theo nút; nút khuất hẳn thì đóng
function followDropdowns(e) {
  if (e && e.target && e.target.closest && e.target.closest('.dd-panel')) return;   // đang cuộn trong danh sách
  document.querySelectorAll('.dd').forEach((w) => {
    if (!w._place) return;
    const r = w._btn.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) w._close();
    else w._place();
  });
}
window.addEventListener('resize', followDropdowns);
document.addEventListener('scroll', followDropdowns, true);

/* ================== Thông báo & xác nhận ================== */
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'err' ? 6000 : 3000);
}

function confirmBox(title, msg, okText = 'Đồng ý', danger = false) {
  const dlg = $('#dlgConfirm');
  $('#cfTitle').textContent = title;
  $('#cfMsg').textContent = msg;
  $('#cfOk').textContent = okText;
  $('#cfOk').className = 'btn primary' + (danger ? ' danger-fill' : '');
  dlg.returnValue = 'cancel';
  dlg.showModal();
  $('#cfOk').focus();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

/* ================== Gọi máy chủ (Google Apps Script) ================== */
async function call(action, extra = {}, settings = state.settings) {
  if (!settings.url) {
    const e = new Error('Chưa cài đặt link Web App — bấm ⚙ Cài đặt');
    e.code = 'CONFIG';
    throw e;
  }
  setBusy(+1);
  try {
    const res = await sys.request({
      url: settings.url.trim(),
      body: { key: settings.key, by: settings.user || 'Không rõ', action, ...extra },
    });
    if (!res || !res.ok) {
      const e = new Error((res && res.error) || 'Lỗi không xác định');
      e.code = res && res.code;
      e.data = res;
      throw e;
    }
    return res;
  } finally {
    setBusy(-1);
  }
}

function setBusy(d) {
  state.busy = Math.max(0, state.busy + d);
  updateSync();
}

function updateSync() {
  const dot = $('#syncDot'), txt = $('#syncText');
  dot.className = 'dot';
  if (state.busy > 0) {
    dot.classList.add('busy');
    txt.textContent = 'Đang đồng bộ…';
  } else if (state.online && state.lastSync) {
    dot.classList.add('ok');
    txt.textContent = 'Đã đồng bộ ' + state.lastSync.toLocaleTimeString('vi-VN');
  } else if (state.lastError) {
    dot.classList.add('err');
    txt.textContent = 'Mất kết nối';
  } else {
    txt.textContent = 'Chưa kết nối';
  }
  const banner = $('#banner');
  if (!state.online && state.lastError && state.settings.url) {
    const cached = state.cacheAt ? ` Đang hiển thị dữ liệu lưu tạm lúc ${new Date(state.cacheAt).toLocaleString('vi-VN')}.` : '';
    banner.textContent = `Không kết nối được Google Sheet: ${state.lastError}${cached} Chưa thể lưu thay đổi cho đến khi có kết nối.`;
    banner.className = 'banner';
  } else {
    banner.className = 'banner hidden';
  }
}

function saveCache() {
  state.cacheAt = Date.now();
  sys.setCache({ data: state.data, since: state.since, savedAt: state.cacheAt, url: state.settings.url, key: state.settings.key, me: state.me });
}

async function connect() {
  try {
    const p = await call('ping');
    setMe(p);
    state.sheetName = p.name;
    state.sheetUrl = p.url || '';
    $('#sheetName').textContent = 'Google Sheet: ' + p.name;
    $('#sheetName').title = p.url || '';
  } catch (e) {
    state.lastError = e.message;
    state.online = false;
    updateSync();
  }
  await refresh({ silent: true, full: true });
  startTimer();
}

/** Đồng bộ: lần đầu tải toàn bộ, sau đó chỉ tải phần thay đổi */
async function refresh({ silent = false, full = false } = {}) {
  if (!state.settings.url || state.refreshing) return;
  state.refreshing = true;
  try {
    const res = await call('sync', { since: full ? '' : state.since });
    setMe(res);
    let changes = 0;
    for (const t of TABLES) {
      const { rows, ids } = res.tables[t];
      if (res.full) {
        const prev = new Map(state.data[t].map((x) => [x.id, x.updatedAt]));
        if (state.lastSync) rows.forEach((x) => { if (prev.get(x.id) !== x.updatedAt) { state.flash.add(x.id); changes++; } });
        state.data[t] = rows;
      } else {
        const map = new Map(state.data[t].map((x) => [x.id, x]));
        rows.forEach((x) => {
          const old = map.get(x.id);
          if (!old || old.updatedAt !== x.updatedAt) { state.flash.add(x.id); changes++; }
          map.set(x.id, x);
        });
        const keep = new Set(ids);
        const before = map.size;
        const list = [...map.values()].filter((x) => keep.has(x.id));
        changes += before - list.length;
        state.data[t] = list;
      }
    }
    state.since = res.serverTime;
    state.lastSync = new Date();
    state.online = true;
    state.lastError = null;
    saveCache();
    if (changes || res.full) render();
    if (!silent) toast('Đã cập nhật dữ liệu mới nhất');
  } catch (e) {
    state.online = false;
    state.lastError = e.message;
    if (!silent) toast(e.message, 'err');
  } finally {
    state.refreshing = false;
    updateSync();
  }
}

function startTimer() {
  clearInterval(state.timer);
  const sec = Math.max(5, Number(state.settings.refreshSec) || 20);
  state.timer = setInterval(() => refresh({ silent: true }), sec * 1000);
}

function upsertLocal(table, item) {
  if (!item) return;
  const list = state.data[table];
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item;
  else list.push(item);
  state.flash.add(item.id);
  saveCache();
}
function removeLocal(table, id) {
  state.data[table] = state.data[table].filter((x) => x.id !== id);
  saveCache();
}

/* ================== Lưu có xử lý xung đột ================== */
function normVal(k, v) {
  if (NUMERIC.includes(k)) return String(toNum(v));
  if (DATES.includes(k)) return joinDT(toISODate(v), timeOf(v)) || String(v ?? '').trim();
  return String(v ?? '').trim();
}
function changedKeys(table, a, b) {
  return KEYS[table].filter((k) => k in b && normVal(k, a[k]) !== normVal(k, b[k]));
}
function showVal(k, v) {
  if (v === '' || v === null || v === undefined) return '(trống)';
  if (NUMERIC.includes(k) && k !== 'days') return fmtMoney(v);
  if (DATES.includes(k)) return fmtDate(v);
  if (k === 'itemsJson') return itemsText(parseItems({ itemsJson: v })) || '(trống)';
  return `"${v}"`;
}

/**
 * Gửi thay đổi lên. Nếu người khác vừa sửa cùng bản ghi:
 *  - khác ô → tự gộp; trùng ô → hỏi có ghi đè không.
 * send(force) phải gọi máy chủ và trả về kết quả.
 */
async function withConflict(table, original, changes, send) {
  try {
    return await send(false);
  } catch (e) {
    if (e.code !== 'CONFLICT') throw e;
    const cur = e.data.current;
    const theirs = changedKeys(table, original, cur);
    const overlap = Object.keys(changes).filter((k) => theirs.includes(k) && k !== 'items');
    if (overlap.length) {
      const lines = overlap.map((k) => `• ${LABELS[k]}: bên kia = ${showVal(k, cur[k])}, bạn = ${showVal(k, changes[k])}`).join('\n');
      const ok = await confirmBox(
        'Dữ liệu vừa bị thay đổi',
        `Bản ghi này vừa được ${cur.updatedBy || 'người khác'} cập nhật lúc ${fmtDateTime(cur.updatedAt)}.\n\n${lines}\n\nGhi đè bằng dữ liệu của bạn?`,
        'Ghi đè',
        true,
      );
      if (!ok) {
        upsertLocal(table, cur);
        render();
        const err = new Error('Đã giữ dữ liệu của bên kia');
        err.code = 'CANCELLED';
        throw err;
      }
    }
    return await send(true);
  }
}

/* ================== Các màn hình ================== */
const VIEWS = {
  rentals: {
    add: '＋ Tạo đơn thuê',
    search: 'Tìm mã đơn, khách, SĐT, thiết bị, ghi chú…',
    cols: [['id', 'Mã đơn'], ['customerName', 'Khách hàng'], ['items', 'Thiết bị'], ['rentDate', 'Thời gian'], ['days', 'Số ngày', 'num'],
      ['subtotal', 'Tiền thuê', 'num'], ['paid', 'Cọc + thu trước', 'num'], ['due', 'Còn phải thu', 'num'], ['status', 'Trạng thái'], ['', '']],
    f1: () => [['', 'Tất cả trạng thái'], ...RENTAL_STATUSES.map((s) => [s, s]), ['__late', 'Quá hạn trả'], ['__due', 'Còn phải thu']],
    // chỉ chủ (xem mọi chi nhánh) mới cần lọc theo chi nhánh
    f2: () => {
      const names = [...new Set(state.data.rentals.filter(isOwn).map((r) => r.branch).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi'));
      return state.me.owner || names.length > 1 ? [['', 'Tất cả chi nhánh'], ...names.map((v) => [v, v])] : null;
    },
  },
  devices: {
    add: '＋ Thêm thiết bị',
    search: 'Tìm tên, loại, serial, ghi chú…',
    cols: [['name', 'Tên thiết bị'], ['category', 'Loại'], ['serial', 'Serial / Mã'], ['price', 'Giá/ngày', 'num'],
      ['status', 'Tình trạng'], ['customer', 'Đang ở chỗ'], ['count', 'Lượt thuê', 'num'], ['', '']],
    f1: () => [['', 'Tất cả tình trạng'], ...['Sẵn sàng', 'Đang cho thuê', 'Đã đặt', 'Bảo trì', 'Ngừng sử dụng'].map((s) => [s, s])],
    f2: () => [['', 'Tất cả loại'], ...uniq('devices', 'category').map((v) => [v, v])],
  },
  customers: {
    add: '＋ Thêm khách hàng',
    search: 'Tìm tên, SĐT, CCCD, địa chỉ…',
    cols: [['name', 'Khách hàng'], ['phone', 'SĐT'], ['idCard', 'CCCD'], ['address', 'Địa chỉ'], ['count', 'Số lần thuê', 'num'],
      ['spent', 'Tổng chi', 'num'], ['due', 'Còn nợ', 'num'], ['last', 'Lần thuê gần nhất'], ['', '']],
    f1: () => [['', 'Tất cả khách'], ['__active', 'Đang thuê'], ['__due', 'Còn nợ']],
    f2: null,
  },
};

function uniq(table, key) {
  return [...new Set(state.data[table].map((i) => String(i[key] ?? '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi'));
}

function matches(q, fields) {
  if (!q) return true;
  const hay = fold(fields.join(' '));
  return fold(q).split(/\s+/).every((w) => hay.includes(w));
}

function rentalsInPeriod() {
  const list = state.data.rentals.filter(isOwn);
  if (state.period === 'active') return list.filter((r) => ACTIVE.includes(r.status));
  if (state.period === 'month') return list.filter((r) => (toISODate(r.rentDate) || String(r.createdAt || '')).slice(0, 7) === state.month);
  return list;
}

function listFor(view) {
  const f = state.vf[view];
  let list;
  if (view === 'rentals') {
    list = rentalsInPeriod().filter((r) => {
      if (f.f1 === '__late' ? !isLate(r) : f.f1 === '__due' ? !due(r) : f.f1 && r.status !== f.f1) return false;
      if (f.f2 && r.branch !== f.f2) return false;
      return matches(f.q, [r.id, r.customerName, r.phone, r.items, r.note, r.branch, r.status]);
    });
  } else if (view === 'devices') {
    list = state.data.devices.map((d) => Object.assign(d, { _st: deviceStatus(d) })).filter((d) => {
      if (f.f1 && d._st.key !== f.f1) return false;
      if (f.f2 && d.category !== f.f2) return false;
      return matches(f.q, [d.name, d.category, d.serial, d.note, d.id]);
    });
  } else {
    list = state.data.customers.map((c) => Object.assign(c, { _s: customerStats(c) })).filter((c) => {
      if (f.f1 === '__active' && !c._s.active) return false;
      if (f.f1 === '__due' && !c._s.due) return false;
      return matches(f.q, [c.name, c.phone, digits(c.phone), c.idCard, c.address, c.note]);
    });
  }
  const { key, desc } = state.sort[view];
  const val = (x) => {
    switch (key) {
      case 'rentDate': return (stamp(x.rentDate) || '') + x.id;
      case 'days': case 'total': case 'price': return n0(x[key]);
      case 'subtotal': return rentPrice(x);
      case 'paid': return view === 'rentals' ? received(x) : n0(x[key]);
      case 'status': return view === 'devices' ? x._st.key : (isLate(x) ? '0' : String(RENTAL_STATUSES.indexOf(x.status) + 1));
      case 'count': return view === 'devices' ? (state.idx.byDevice.get(x.id) || []).length : x._s.count;
      case 'spent': return x._s.spent;
      case 'due': return view === 'rentals' ? due(x) - refund(x) : x._s.due;   // đơn: trả lại khách xếp cuối
      case 'last': return x._s.last;
      case 'customer': return fold(x._st.rental ? x._st.rental.customerName : '');
      default: return fold(x[key]);
    }
  };
  list.sort((a, b) => {
    const va = val(a), vb = val(b);
    const r = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb), 'vi', { numeric: true });
    return desc ? -r : r;
  });
  return list;
}

/* ---------- Thống kê ---------- */
function statCard(label, value, color, filter, money = false) {
  const active = filter !== null && state.vf[state.view].f1 === filter && filter !== '';
  return `<button class="stat ${filter === null ? 'static' : ''} ${active ? 'active' : ''}" ${filter !== null ? `data-f1="${esc(filter)}"` : ''}>
    <div class="label"><span class="sw" style="background:${color}"></span>${label}</div>
    <div class="value ${money ? 'money' : ''}">${value}</div></button>`;
}

function renderStats() {
  let html = '';
  if (state.view === 'rentals') {
    const fb = state.vf.rentals.f2;
    const base = rentalsInPeriod().filter((r) => !fb || r.branch === fb);
    const valid = base.filter((r) => r.status !== 'Đã hủy');
    const money = (list) => ({
      revenue: list.reduce((s, r) => s + n0(r.total), 0),
      paid: list.reduce((s, r) => s + collected(r), 0),   // đã thu = cọc + thu trước (không vượt thành tiền)
      owe: list.reduce((s, r) => s + due(r), 0),
    });
    const title = state.period === 'month' ? fmtMonth(state.month) : state.period === 'active' ? 'đang hoạt động' : 'tất cả';
    let moneyCards;
    const names = [...new Set([...state.branches, ...valid.map((r) => r.branch).filter(Boolean)])];
    if (valid.some((r) => !r.branch)) names.push('');
    if (state.me.owner && !fb && names.length) {
      // Mã chủ: doanh thu tính riêng từng chi nhánh, không cộng tổng các chi nhánh
      moneyCards = names.map((b) => {
        const m = money(valid.filter((r) => fold(r.branch) === fold(b)));
        return `<button class="stat ${b ? '' : 'static'}" ${b ? `data-branch="${esc(b)}" title="Chỉ xem ${esc(b)}"` : ''}>
          <div class="label"><span class="sw" style="background:var(--primary)"></span>Doanh thu · ${esc(b || 'Chưa có chi nhánh')}</div>
          <div class="value money">${fmtShortMoney(m.revenue)}</div>
          <div class="sub">Đã thu ${fmtShortMoney(m.paid)} · <span class="${m.owe ? 'due-text' : ''}">còn ${fmtShortMoney(m.owe)}</span></div></button>`;
      }).join('');
    } else {
      const mine = valid.filter(countsRevenue);
      const m = money(mine);
      const who = fb && state.me.owner ? fb : (!state.me.legacy && !state.me.owner ? state.me.branch : fb);
      const helped = valid.length - mine.length;   // đơn mình tạo hộ chi nhánh khác: không cộng vào doanh thu
      moneyCards = statCard('Doanh thu' + (who ? ' · ' + esc(who) : ''), fmtShortMoney(m.revenue), 'var(--primary)', null, true)
          .replace('</button>', helped ? `<div class="sub">không tính ${helped} đơn tạo hộ chi nhánh khác</div></button>` : '</button>') +
        statCard('Đã thu', fmtShortMoney(m.paid), 'var(--ok-fg)', null, true) +
        statCard('Còn phải thu', fmtShortMoney(m.owe), 'var(--late-fg)', '__due', true);
    }
    html = statCard('Số đơn ' + title, valid.length, 'var(--muted)', '') + moneyCards +
      statCard('Đặt trước', base.filter((r) => r.status === 'Đặt trước').length, 'var(--res-fg)', 'Đặt trước') +
      statCard('Đang thuê', base.filter((r) => r.status === 'Đang thuê').length, 'var(--rent-fg)', 'Đang thuê') +
      statCard('Quá hạn trả', base.filter(isLate).length, 'var(--late-fg)', '__late');
  } else if (state.view === 'devices') {
    const sts = state.data.devices.map((d) => deviceStatus(d).key);
    const c = (k) => sts.filter((s) => s === k).length;
    html = statCard('Tổng thiết bị', sts.length, 'var(--muted)', '') +
      statCard('Sẵn sàng', c('Sẵn sàng'), 'var(--ok-fg)', 'Sẵn sàng') +
      statCard('Đang cho thuê', c('Đang cho thuê'), 'var(--rent-fg)', 'Đang cho thuê') +
      statCard('Đã đặt', c('Đã đặt'), 'var(--res-fg)', 'Đã đặt') +
      statCard('Bảo trì', c('Bảo trì'), 'var(--mnt-fg)', 'Bảo trì') +
      statCard('Ngừng sử dụng', c('Ngừng sử dụng'), 'var(--mnt-fg)', 'Ngừng sử dụng');
  } else {
    const all = state.data.customers.map((c) => customerStats(c));
    const newThisMonth = state.data.customers.filter((c) => String(c.createdAt || '').slice(0, 7) === thisMonth()).length;
    html = statCard('Tổng khách hàng', all.length, 'var(--muted)', '') +
      statCard('Đang thuê', all.filter((s) => s.active).length, 'var(--rent-fg)', '__active') +
      statCard('Còn nợ', all.filter((s) => s.due).length, 'var(--late-fg)', '__due') +
      statCard('Khách mới tháng này', newThisMonth, 'var(--ok-fg)', null);
  }
  $('#stats').innerHTML = html;
}

/* ---------- Bảng ---------- */
/* Ô "Còn phải thu" ngoài danh sách: đã trừ giảm giá, tiền cọc và tiền thu trước */
function remainCell(r) {
  if (r.status === 'Đã hủy') return refund(r) ? `<span class="refund-text">Trả lại ${fmtMoney(refund(r))}</span>` : '<span class="muted">—</span>';
  const owe = due(r), back = refund(r);
  if (owe) return `<b class="due-text">${fmtMoney(owe)}</b><div><button class="btn sm pay-full" data-act="payfull" title="Ghi nhận khách đã trả đủ ${fmtMoney(owe)}">✓ Thu đủ</button></div>`;
  if (back) return `<span class="refund-text">Trả lại ${fmtMoney(back)}</span>`;
  return '<span class="ok-text">Đủ</span>';
}

function rowRental(r) {
  const late = isLate(r);
  const today = todayISO();
  // xuống dòng giữa lúc thuê và lúc trả để cột không quá rộng
  const span = (a, b) => `<span class="nw">${fmtDate(a)} →</span> <span class="nw">${fmtDate(b)}</span>`;
  let time = span(r.rentDate, r.returnDate);
  if (r.status === 'Đã trả' && r.returnedDate) time = span(r.rentDate, r.returnedDate);
  const lateNote = late ? `<div class="small late-text">Trễ ${daysBetween(toISODate(r.returnDate), today)} ngày</div>` : '';
  let act = '';
  if (r.status === 'Đặt trước') act = `<button class="btn sm" data-act="deliver">Giao máy</button>`;
  else if (r.status === 'Đang thuê') act = `<button class="btn sm" data-act="return">Trả máy</button>`;
  return `<tr data-id="${esc(r.id)}" class="${state.flash.has(r.id) ? 'flash' : ''}">
    <td><div class="title">${esc(r.id)}</div><div class="small">${esc(r.branch)}${createdElsewhere(r) ? ` · <span class="helped">tạo bởi ${esc(r.createdBranch)}</span>` : ''}</div></td>
    <td>${esc(r.customerName)}${r.phone ? `<div class="small">${esc(r.phone)}</div>` : ''}</td>
    <td class="items">${esc(r.items)}</td>
    <td class="${late ? 'late-text' : ''}">${time}${lateNote}</td>
    <td class="num">${esc(r.days)}</td>
    <td class="num">${fmtMoney(rentPrice(r))}${n0(r.discount) ? `<div class="small">giảm ${fmtMoney(r.discount)}</div>` : ''}</td>
    <td class="num">${received(r) ? fmtMoney(received(r)) : '<span class="muted">0 đ</span>'}${n0(r.deposit) ? `<div class="small">cọc ${fmtMoney(r.deposit)}</div>` : ''}${n0(r.paid) ? `<div class="small">thu trước ${fmtMoney(r.paid)}</div>` : ''}</td>
    <td class="num remain">${remainCell(r)}</td>
    <td>${rentalChip(r)}</td>
    <td class="act">${act}</td></tr>`;
}

function rowDevice(d) {
  const st = d._st;
  const count = (state.idx.byDevice.get(d.id) || []).filter((r) => r.status !== 'Đã hủy').length;
  // đơn của chi nhánh khác: chỉ biết chi nhánh nào đang giữ máy, không biết khách
  const holder = st.rental ? (st.rental.masked ? esc(st.rental.branch || 'Chi nhánh khác') : esc(st.rental.customerName)) : '';
  const who = st.rental ? `${holder}<div class="small">${st.key === 'Đang cho thuê' ? 'đến ' + fmtDate(st.rental.returnDate) : fmtDate(st.rental.rentDate) + ' → ' + fmtDate(st.rental.returnDate)}</div>` : '';
  const act = st.key === 'Sẵn sàng' || st.key === 'Đã đặt' ? `<button class="btn sm" data-act="rent">Cho thuê</button>` : '';
  return `<tr data-id="${esc(d.id)}" class="${state.flash.has(d.id) ? 'flash' : ''}">
    <td class="wrap"><div class="title">${esc(d.name)}</div>${d.note ? `<div class="small">${esc(d.note)}</div>` : ''}</td>
    <td>${esc(d.category)}</td><td>${d.serial ? esc(d.serial) : `<span class="muted small">${esc(unitText(d))}</span>`}</td>
    <td class="num">${fmtMoney(d.price)}</td>
    <td><span class="chip ${st.cls}">${esc(st.text)}</span></td>
    <td>${who}</td>
    <td class="num">${count}</td>
    <td class="act">${act}</td></tr>`;
}

function rowCustomer(c) {
  const s = c._s;
  return `<tr data-id="${esc(c.id)}" class="${state.flash.has(c.id) ? 'flash' : ''}">
    <td class="wrap"><div class="title">${esc(c.name)}</div>${c.note ? `<div class="small">${esc(c.note)}</div>` : ''}</td>
    <td>${esc(c.phone)}</td><td>${esc(c.idCard)}</td><td class="wrap">${esc(c.address)}</td>
    <td class="num">${s.count}${s.active ? `<div class="small">${s.active} đang thuê</div>` : ''}</td>
    <td class="num">${fmtMoney(s.spent)}</td>
    <td class="num ${s.due ? 'due-text' : ''}">${s.due ? fmtMoney(s.due) : ''}</td>
    <td>${s.last ? fmtDate(s.last) : ''}</td>
    <td class="act"><button class="btn sm" data-act="rent">Tạo đơn</button></td></tr>`;
}

function fillSelect(sel, opts, cur) {
  const box = sel.closest('.dd') || sel;
  if (!opts) { box.classList.add('hidden'); return ''; }
  box.classList.remove('hidden');
  sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  sel.value = opts.some(([v]) => v === cur) ? cur : '';
  return sel.value;
}

function render() {
  buildIndex();
  const view = state.view, V = VIEWS[view], f = state.vf[view];

  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#btnAdd').textContent = V.add;
  $('#period').classList.toggle('hidden', view !== 'rentals');
  document.querySelectorAll('#periodSeg button').forEach((b) => b.classList.toggle('active', b.dataset.period === state.period));
  $('#monthNav').classList.toggle('hidden', state.period !== 'month');
  $('#monthBtn').textContent = fmtMonth(state.month);
  $('#q').placeholder = V.search + (matchMedia('(max-width: 760px)').matches ? '' : '  (Ctrl/Cmd + F)');   // điện thoại: không có phím tắt
  if ($('#q').value !== f.q) $('#q').value = f.q;
  f.f1 = fillSelect($('#f1'), V.f1(), f.f1);
  f.f2 = fillSelect($('#f2'), V.f2 && V.f2(), f.f2);

  renderStats();

  const sort = state.sort[view];
  $('#thead').innerHTML = '<tr>' + V.cols.map(([k, label, cls]) =>
    `<th ${k ? `data-sort="${k}"` : ''} class="${cls || ''} ${!k ? 'act' : ''} ${sort.key === k ? 'sorted' + (sort.desc ? ' desc' : '') : ''}">${label}</th>`).join('') + '</tr>';

  const list = listFor(view);
  const rowFn = view === 'rentals' ? rowRental : view === 'devices' ? rowDevice : rowCustomer;
  $('#tbody').innerHTML = list.map(rowFn).join('');
  // nhãn cột cho từng ô — trên điện thoại mỗi dòng hiện thành một thẻ "Nhãn: giá trị"
  const labels = V.cols.map((c) => c[1]);
  $('#tbody').querySelectorAll('tr').forEach((tr) => [...tr.children].forEach((td, i) => { if (labels[i]) td.dataset.label = labels[i]; }));
  document.body.dataset.view = view;
  state.flash.clear();

  const total = view === 'rentals' ? rentalsInPeriod().length : state.data[view].length;
  const unit = view === 'rentals' ? 'đơn' : view === 'devices' ? 'thiết bị' : 'khách';
  $('#count').textContent = list.length === total ? `${list.length} ${unit}` : `${list.length} / ${total} ${unit}`;

  const empty = $('#empty');
  empty.classList.toggle('hidden', list.length > 0);
  if (!list.length) {
    if (!state.settings.url) empty.innerHTML = 'Chưa kết nối Google Sheet. Bấm <b>⚙ Cài đặt</b> để dán link Web App, hoặc <b>Hướng dẫn</b> để xem cách tạo.';
    else if (view === 'rentals' && !state.data.devices.length) empty.innerHTML = 'Bắt đầu bằng cách vào tab <b>Thiết bị</b> và thêm các thiết bị bạn đang có.';
    else if (total) empty.innerHTML = 'Không có mục nào khớp bộ lọc.';
    else if (view === 'rentals') empty.innerHTML = state.period === 'active' ? 'Không có đơn nào đang hoạt động. Bấm <b>＋ Tạo đơn thuê</b>.' : 'Không có đơn thuê nào trong khoảng này.';
    else if (view === 'devices') empty.innerHTML = 'Chưa có thiết bị nào. Bấm <b>＋ Thêm thiết bị</b> để nhập danh mục thiết bị bạn đang có.';
    else empty.innerHTML = 'Chưa có khách hàng. Khách được tự lưu khi bạn tạo đơn thuê, hoặc bấm <b>＋ Thêm khách hàng</b>.';
  }

  const opts = (vals) => vals.map((v) => `<option value="${esc(v)}"></option>`).join('');
  $('#dlCategory').innerHTML = opts(uniq('devices', 'category'));
  const s = state.settings;
  $('#whoLabel').textContent = [s.user, state.me.legacy ? s.branch : state.me.owner ? 'Chủ — mọi chi nhánh' : state.me.branch].filter(Boolean).join(' · ');
  $('#btnOpenSheet').classList.toggle('hidden', !state.me.owner);   // file Sheet chứa doanh thu mọi chi nhánh

  if (state.rf && $('#dlgRental').open) renderPicker();   // dữ liệu mới về khi đang mở form
}

/* ======================================================================
   FORM ĐƠN THUÊ
   ====================================================================== */
const rForm = () => $('#rentalForm').elements;

function openRental(rental = null, preset = {}) {
  const r = rental ? { ...rental } : {
    status: 'Đang thuê', branch: myBranch(), rentDate: joinDT(todayISO(), nowTime()), returnDate: '', days: 1,
  };
  Object.assign(r, preset.fields || {});
  const items = rental ? parseItems(rental) : [];
  (preset.devices || []).forEach((d) => {
    if (!items.some((i) => i.id === d.id)) items.push({ id: d.id, name: d.name, serial: d.serial, price: n0(d.price) });
  });
  const customer = preset.customer || (rental && state.data.customers.find((c) => c.id === rental.customerId)) || null;

  state.rf = { original: rental ? { ...rental } : null, customer, items, daysManual: false };

  $('#rentalForm').reset();
  $('#rStatus').innerHTML = RENTAL_STATUSES.map((s) => `<option>${s}</option>`).join('');
  const f = rForm();
  f.status.value = RENTAL_STATUSES.includes(r.status) ? r.status : 'Đang thuê';
  // chi nhánh nhận đơn (bắt buộc): mặc định chi nhánh mình, có thể chọn chi nhánh khác để tạo hộ.
  // Doanh thu của đơn tính cho chi nhánh được chọn.
  const br = r.branch || '';
  const brList = branchOptions(br);
  const brDefault = brList.find((b) => fold(b) === fold(br)) || (brList.length === 1 ? brList[0] : '');
  f.branch.innerHTML = `<option value="">— Chọn chi nhánh —</option>` + brList.map((b) => `<option>${esc(b)}</option>`).join('');
  f.branch.value = brDefault;
  f.branch.disabled = false;
  f.branch.title = 'Chi nhánh nhận đơn — doanh thu tính cho chi nhánh này';
  [['rentDate', 'rentTime'], ['returnDate', 'returnTime'], ['returnedDate', 'returnedTime']].forEach(([d, t]) => {
    f[d].value = toISODate(r[d]);
    f[t].value = timeOf(r[d]);
  });
  f.note.value = r.note || '';
  ['discount', 'deposit', 'paid'].forEach((k) => setMoney(f[k], r[k]));
  // tick "Đã thu đủ" khi đơn đã thu vừa đủ (thu trước = thành tiền − cọc)
  const pf = $('#rPaidFull');
  pf.checked = !!rental && rental.status !== 'Đã hủy' && n0(rental.total) > 0 && due(rental) === 0
    && n0(rental.paid) === Math.max(0, n0(rental.total) - n0(rental.deposit));
  state.rf.paidBefore = f.paid.value;
  f.days.value = r.days === '' || r.days === undefined ? autoDays() : r.days;
  state.rf.daysManual = rental ? String(toNum(r.days)) !== String(autoDays()) : false;

  // khách
  $('#custName').value = customer ? customer.name : (rental ? rental.customerName : '');
  $('#custPhone').value = customer ? customer.phone : (rental ? rental.phone : '');
  $('#custIdCard').value = customer ? customer.idCard : '';
  $('#custAddress').value = customer ? customer.address : '';
  $('#devSearch').value = '';

  $('#rTitle').textContent = rental ? (preset.title || 'Đơn thuê') : 'Tạo đơn thuê';
  renderBranchTag();
  $('#rCode').textContent = rental ? rental.id : '';
  $('#rMeta').textContent = rental ? `Tạo ${fmtDateTime(rental.createdAt)} bởi ${rental.createdBy || '—'} · Cập nhật ${fmtDateTime(rental.updatedAt)} bởi ${rental.updatedBy || '—'}` : '';
  $('#rDelete').classList.toggle('hidden', !rental);
  $('#rSave').disabled = false;
  $('#rSave').textContent = 'Lưu đơn';

  if (preset.fields && preset.fields.status === 'Đã trả') {
    if (!f.returnedDate.value) { f.returnedDate.value = todayISO(); f.returnedTime.value = nowTime(); }
    state.rf.daysManual = false;
    f.days.value = autoDays();
  }
  updateReturnedVisibility();
  renderCustBadge();
  renderPicker();
  renderSelected();
  $('#dlgRental').showModal();
  autoFocus(customer || rental ? $('#devSearch') : $('#custName'));
  if (preset.focus) autoFocus(rForm()[preset.focus]);
}

/* Ngày + giờ đang nhập trong form → [ngày, giờ] của lúc nhận máy và lúc trả (thực tế nếu đã trả) */
function formTimes() {
  const f = rForm();
  const returned = f.status.value === 'Đã trả' && f.returnedDate.value;
  return {
    sD: f.rentDate.value, sT: normTime(f.rentTime.value),
    eD: returned ? f.returnedDate.value : f.returnDate.value,
    eT: normTime(returned ? f.returnedTime.value : f.returnTime.value),
  };
}

/* Số ngày tính tiền: có giờ → mỗi 24 giờ là 1 ngày (lẻ làm tròn lên); chỉ có ngày → số ngày chênh lệch */
function autoDays() {
  const { sD, sT, eD, eT } = formTimes();
  if (!sD || !eD) return 1;
  if (sT && eT) {
    const mins = (Date.parse(`${eD}T${eT}`) - Date.parse(`${sD}T${sT}`)) / 60000;
    return Math.max(1, Math.ceil(mins / 1440));
  }
  return Math.max(1, daysBetween(sD, eD));
}

function renderBranchTag() {
  const b = rForm().branch.value;
  const orig = state.rf && state.rf.original;
  const by = orig ? orig.createdBranch : (state.me.owner ? '' : state.me.branch);   // chi nhánh tạo đơn
  const helping = b && by && fold(by) !== fold(b);
  const el = $('#rBranchTag');
  el.textContent = !b ? 'Chưa chọn chi nhánh'
    : helping ? `Doanh thu tính cho: ${b} · tạo bởi ${by}` : 'Chi nhánh: ' + b;
  el.className = 'branch-tag' + (!b ? ' missing' : helping ? ' helping' : '');
}

function updateReturnedVisibility() {
  $('#returnedWrap').classList.toggle('hidden', rForm().status.value !== 'Đã trả');
}

function calc() {
  const f = rForm();
  const perDay = state.rf.items.reduce((s, i) => s + n0(i.price), 0);
  const days = n0(f.days.value);
  const subtotal = perDay * days;
  const discount = n0(f.discount.value);
  const total = Math.max(0, subtotal - discount);
  const paid = n0(f.paid.value);
  const deposit = n0(f.deposit.value);
  const cancelled = f.status.value === 'Đã hủy';
  const got = deposit + paid;                                     // cọc được trừ vào số phải trả
  return {
    perDay, days, subtotal, discount, total, paid, deposit,
    due: cancelled ? 0 : Math.max(0, total - got),
    refund: cancelled ? got : Math.max(0, got - total),
  };
}

function renderSummary() {
  const f = rForm(), pf = $('#rPaidFull');
  const cancelled = f.status.value === 'Đã hủy';
  if (cancelled && pf.checked) { pf.checked = false; setMoney(f.paid, state.rf.paidBefore); }
  pf.disabled = cancelled;
  if (pf.checked) { const c0 = calc(); setMoney(f.paid, Math.max(0, c0.total - c0.deposit)); }   // theo kịp khi đổi ngày, giá, cọc
  const c = calc();
  const m = (v) => fmtMoney(v) || '0 đ';
  const last = c.refund
    ? `<div class="refund">Trả lại khách<b>${m(c.refund)}</b></div>`
    : `<div class="${c.due ? 'due' : ''}">Còn phải thu<b>${m(c.due)}</b></div>`;
  $('#rSummary').innerHTML = `
    <div class="big" title="${c.days} ngày × ${m(c.perDay)} = ${m(c.subtotal)}${c.discount ? ' − giảm ' + m(c.discount) : ''}">Thành tiền <small>(${c.days} ngày${c.discount ? ', giảm ' + m(c.discount) : ' × ' + m(c.perDay)})</small><b>${m(c.total)}</b></div>
    <div>Trừ tiền cọc<b>− ${m(c.deposit)}</b></div>
    <div>Thu trước<b>− ${m(c.paid)}</b></div>
    ${last}`;
}

/* ---------- Khách hàng: tìm khách cũ hoặc nhập mới ---------- */
function renderCustBadge() {
  const rf = state.rf, el = $('#custBadge');
  const name = $('#custName').value.trim();
  if (rf.customer) {
    const s = customerStats(rf.customer);
    el.innerHTML = `<span class="tag old">Khách cũ</span><span class="muted">${s.count} lần thuê${s.last ? ' · gần nhất ' + fmtDate(s.last) : ''}${s.due ? ' · <span class="due-text">còn nợ ' + fmtMoney(s.due) + '</span>' : ''}</span>
      <button type="button" class="linkbtn" id="custClear">Đổi khách khác</button>`;
    $('#custClear').onclick = () => {
      rf.customer = null;
      ['#custName', '#custPhone', '#custIdCard', '#custAddress'].forEach((s) => ($(s).value = ''));
      renderCustBadge();
      $('#custName').focus();
    };
    return;
  }
  if (!name) { el.innerHTML = '<span class="muted">Gõ tên hoặc số điện thoại để chọn khách cũ.</span>'; return; }
  const ph = digits($('#custPhone').value);
  const dup = ph.length >= 8 && state.data.customers.find((c) => digits(c.phone) === ph);
  if (dup) {
    el.innerHTML = `<span class="tag warn">SĐT trùng khách cũ: ${esc(dup.name)}</span><button type="button" class="linkbtn" id="custUseDup">Chọn khách này</button>`;
    $('#custUseDup').onclick = () => selectCustomer(dup);
  } else {
    el.innerHTML = '<span class="tag new">Khách mới</span><span class="muted">sẽ được lưu vào danh sách khách hàng</span>';
  }
}

function custMatches(q) {
  const list = state.data.customers;
  if (!q) {
    return list.map((c) => [c, customerStats(c).last]).filter(([, l]) => l).sort((a, b) => b[1].localeCompare(a[1])).slice(0, 8).map(([c]) => c);
  }
  const fq = fold(q), dq = digits(q);
  return list.filter((c) => {
    if (dq.length >= 3 && digits(c.phone).includes(dq)) return true;
    const hay = fold([c.name, c.phone, c.idCard, c.address].join(' '));
    return fq.split(/\s+/).every((w) => hay.includes(w));
  }).slice(0, 10);
}

let sugIndex = -1;
function showSuggest() {
  const q = $('#custName').value.trim();
  const box = $('#custSuggest');
  if (state.rf.customer && q === state.rf.customer.name) { box.classList.add('hidden'); return; }
  const list = custMatches(q);
  if (!list.length) { box.classList.add('hidden'); return; }
  sugIndex = -1;
  box.innerHTML = `<div class="head">${q ? 'Khách cũ phù hợp' : 'Khách thuê gần đây'}</div>` + list.map((c, i) => {
    const s = customerStats(c);
    return `<div class="opt" data-i="${i}" data-id="${esc(c.id)}">
      <div><div><b>${esc(c.name)}</b></div><div class="small">${esc(c.phone)}${c.idCard ? ' · ' + esc(c.idCard) : ''}${c.address ? ' · ' + esc(c.address) : ''}</div></div>
      <div class="small">${s.count} lần${s.last ? '<br>' + fmtDate(s.last) : ''}</div></div>`;
  }).join('');
  box.classList.remove('hidden');
}
function hideSuggest() { $('#custSuggest').classList.add('hidden'); }

function selectCustomer(c) {
  state.rf.customer = c;
  $('#custName').value = c.name;
  $('#custPhone').value = c.phone || '';
  $('#custIdCard').value = c.idCard || '';
  $('#custAddress').value = c.address || '';
  hideSuggest();
  renderCustBadge();
  autoFocus($('#devSearch'));
}

/* ---------- Chọn thiết bị ---------- */
function currentRange() {
  const { sD, sT, eD, eT } = formTimes();
  const day = sD || todayISO();
  const s = `${day} ${sT || '00:00'}`;
  const e = eD ? `${eD} ${eT || '23:59'}` : `${day} 23:59`;   // chưa có ngày trả: tính bận hết ngày nhận máy
  return [s, e <= s ? `${day} 23:59` : e];
}

/** Các đơn khác đang giữ thiết bị trùng thời gian với đơn này */
function clashes(deviceId) {
  const selfId = state.rf.original && state.rf.original.id;
  const range = currentRange();
  return (state.idx.busy.get(deviceId) || []).filter((r) => r.id !== selfId && overlaps(rentalRange(r), range));
}

function availBadge(d) {
  if (d.state === 'Bảo trì') return `<span class="avail s-mnt">Bảo trì</span>`;
  if (d.state === 'Ngừng sử dụng') return `<span class="avail s-mnt">Ngừng sử dụng</span>`;
  const c = clashes(d.id);
  if (!c.length) return `<span class="avail s-ok">Trống</span>`;
  const r = c[0];
  const who = r.masked ? (r.branch || 'Chi nhánh khác') : r.customerName;   // chi nhánh khác: không hiện tên khách
  return r.status === 'Đang thuê'
    ? `<span class="avail s-late">${esc(who)} đang thuê đến ${fmtDate(r.returnDate, true) || '?'}</span>`
    : `<span class="avail s-res">${r.masked ? esc(who) + ' đã' : 'Đã'} đặt ${fmtDate(r.rentDate, true)}–${fmtDate(r.returnDate, true) || '?'}</span>`;
}

function renderPicker() {
  const q = $('#devSearch').value.trim();
  const sel = new Set(state.rf.items.map((i) => i.id));
  const list = state.data.devices
    .filter((d) => sel.has(d.id) || d.state !== 'Ngừng sử dụng')
    .filter((d) => matches(q, [d.name, d.category, d.serial, d.note]))
    .sort((a, b) => (clashes(a.id).length - clashes(b.id).length) || String(a.category).localeCompare(String(b.category), 'vi') || String(a.name).localeCompare(String(b.name), 'vi'));
  const box = $('#devPicker');
  if (!state.data.devices.length) {
    box.innerHTML = '<div class="sel-empty" style="padding:12px">Chưa có thiết bị nào. Vào tab <b>Thiết bị</b> để thêm danh mục trước.</div>';
  } else if (!list.length) {
    box.innerHTML = '<div class="sel-empty" style="padding:12px">Không tìm thấy thiết bị phù hợp.</div>';
  } else {
    box.innerHTML = list.map((d) => `
      <div class="pick ${sel.has(d.id) ? 'on' : ''}" data-id="${esc(d.id)}">
        <input type="checkbox" ${sel.has(d.id) ? 'checked' : ''} tabindex="-1" />
        <div><div class="name">${esc(d.name)}</div><div class="small">${esc([d.category, unitText(d)].filter(Boolean).join(' · '))}</div></div>
        <div class="right">${fmtMoney(d.price) || '—'}<br>${availBadge(d)}</div>
      </div>`).join('');
  }
  $('#pickHint').textContent = `(${state.data.devices.filter((d) => d.state !== 'Ngừng sử dụng' && !clashes(d.id).length && d.state !== 'Bảo trì').length} thiết bị trống trong thời gian này)`;
}

function renderSelected() {
  const items = state.rf.items;
  $('#selCount').textContent = items.length ? `(${items.length})` : '';
  $('#selList').innerHTML = items.length
    ? items.map((i, k) => `
      <div class="sel-row" data-k="${k}">
        <div class="name">${esc(i.name)} <span class="small">${esc(i.serial || unitText(state.data.devices.find((x) => x.id === i.id) || {}))}</span></div>
        <input class="money sel-price" inputmode="numeric" value="${toNum(i.price) === '' ? '' : n0(i.price).toLocaleString('vi-VN')}" title="Giá thuê/ngày cho đơn này" />
        <button type="button" class="x" title="Bỏ chọn">×</button>
      </div>`).join('')
    : '<div class="sel-empty">Chưa chọn thiết bị nào — bấm vào danh sách phía trên để chọn.</div>';
  renderSummary();
}

function toggleDevice(id) {
  const rf = state.rf;
  const i = rf.items.findIndex((x) => x.id === id);
  if (i >= 0) rf.items.splice(i, 1);
  else {
    const d = state.data.devices.find((x) => x.id === id);
    if (!d) return;
    rf.items.push({ id: d.id, name: d.name, serial: d.serial, price: n0(d.price) });
  }
  renderPicker();
  renderSelected();
}

function onDatesChanged() {
  const f = rForm();
  if (!state.rf.daysManual) f.days.value = autoDays();
  updateReturnedVisibility();
  renderPicker();
  renderSummary();
}

async function submitRental(ev) {
  ev.preventDefault();
  const rf = state.rf, f = rForm();
  const name = $('#custName').value.trim();
  if (!name) { $('#custName').focus(); return toast('Vui lòng nhập hoặc chọn khách hàng', 'err'); }
  if (!rf.items.length) { $('#devSearch').focus(); return toast('Vui lòng chọn ít nhất một thiết bị', 'err'); }
  if (!f.branch.value) { f.branch.focus(); return toast('Vui lòng chọn chi nhánh cho đơn thuê', 'err'); }
  for (const t of ['rentTime', 'returnTime', 'returnedTime']) {
    if (f[t].value.trim() && !normTime(f[t].value)) { f[t].focus(); return toast('Giờ không hợp lệ — nhập dạng 09:30', 'err'); }
  }
  const dt = (d, t) => joinDT(f[d].value, normTime(f[t].value));
  const rentAt = dt('rentDate', 'rentTime'), returnAt = dt('returnDate', 'returnTime'), returnedAt = dt('returnedDate', 'returnedTime');
  if (rentAt && returnAt && stamp(returnAt, true) < stamp(rentAt)) return toast('Thời gian trả dự kiến phải sau lúc thuê', 'err');
  if (f.status.value === 'Đã trả' && rentAt && returnedAt && stamp(returnedAt, true) < stamp(rentAt)) return toast('Thời gian trả thực tế phải sau lúc thuê', 'err');

  if (ACTIVE.includes(f.status.value)) {
    const busy = rf.items.map((i) => [i, clashes(i.id)]).filter(([, c]) => c.length);
    if (busy.length) {
      const lines = busy.map(([i, c]) => `• ${i.name}: ${c.map((r) => r.masked
        ? `${r.branch || 'Chi nhánh khác'} (${r.status.toLowerCase()} ${fmtDate(r.rentDate, true)}–${fmtDate(r.returnDate, true) || '?'})`
        : `${r.customerName} (${r.status.toLowerCase()} ${fmtDate(r.rentDate, true)}–${fmtDate(r.returnDate, true) || '?'}, đơn ${r.id})`).join(', ')}`).join('\n');
      const ok = await confirmBox('Thiết bị đang bận', `Các thiết bị sau trùng lịch với đơn khác:\n\n${lines}\n\nVẫn lưu đơn này?`, 'Vẫn lưu');
      if (!ok) return;
    }
  }

  const c = calc();
  const items = rf.items.map((i) => ({ id: i.id, name: i.name, serial: i.serial || '', price: n0(i.price) }));
  const rental = {
    status: f.status.value,
    branch: f.branch.value.trim(),
    rentDate: rentAt,
    returnDate: returnAt,
    returnedDate: f.status.value === 'Đã trả' ? (returnedAt || joinDT(todayISO(), nowTime())) : '',
    days: c.days, subtotal: c.subtotal, discount: toNum(f.discount.value), total: c.total,
    deposit: toNum(f.deposit.value), paid: toNum(f.paid.value),
    note: f.note.value.trim(),
    items: itemsText(items),
    itemsJson: JSON.stringify(items),
  };
  const customer = {
    id: rf.customer ? rf.customer.id : '',
    name, phone: $('#custPhone').value.trim(), idCard: $('#custIdCard').value.trim(), address: $('#custAddress').value.trim(),
  };

  const btn = $('#rSave');
  btn.disabled = true;
  btn.textContent = 'Đang lưu…';
  try {
    let res;
    if (!rf.original) {
      res = await call('saveRental', { rental, customer });
    } else {
      const orig = rf.original;
      const changes = Object.fromEntries(changedKeys('rentals', orig, rental).map((k) => [k, rental[k]]));
      const custChanged = !rf.customer || ['name', 'phone', 'idCard', 'address'].some((k) => String(rf.customer[k] ?? '') !== customer[k]);
      if (!Object.keys(changes).length && !custChanged && rf.customer && rf.customer.id === orig.customerId) {
        $('#dlgRental').close();
        return toast('Không có thay đổi');
      }
      res = await withConflict('rentals', orig, changes, (force) =>
        call('saveRental', { rental: { ...changes, id: orig.id }, customer, expectedUpdatedAt: orig.updatedAt, force }));
    }
    upsertLocal('customers', res.customer);
    upsertLocal('rentals', res.rental);
    $('#dlgRental').close();
    render();
    toast(`Đã lưu đơn ${res.rental.id} — ${res.rental.customerName}`, 'ok');
  } catch (e) {
    if (e.data && e.data.customer) upsertLocal('customers', e.data.customer);
    if (e.code === 'CANCELLED') { $('#dlgRental').close(); toast(e.message); }
    else toast('Không lưu được: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Lưu đơn';
  }
}

/* Nút "✓ Thu đủ" ngoài danh sách: Thu trước = Thành tiền − Tiền cọc → còn phải thu = 0 */
async function payFull(r) {
  const owe = due(r);
  if (!owe) return;
  const ok = await confirmBox('Đã thu đủ', `Ghi nhận khách ${r.customerName} đã trả đủ ${fmtMoney(owe)} (đơn ${r.id})?\nCòn phải thu sẽ về 0.`, 'Đã thu đủ');
  if (!ok) return;
  const changes = { paid: Math.max(0, n0(r.total) - n0(r.deposit)) };
  try {
    const res = await withConflict('rentals', r, changes, (force) =>
      call('saveRental', { rental: { ...changes, id: r.id }, expectedUpdatedAt: r.updatedAt, force }));
    upsertLocal('rentals', res.rental);
    render();
    toast(`Đã thu đủ ${fmtMoney(owe)} — đơn ${r.id}`, 'ok');
  } catch (e) {
    toast(e.code === 'CANCELLED' ? e.message : 'Không lưu được: ' + e.message, e.code === 'CANCELLED' ? '' : 'err');
  }
}

async function deliverRental(r) {
  const ok = await confirmBox('Giao máy', `Giao thiết bị cho ${r.customerName} (đơn ${r.id})?\nĐơn sẽ chuyển sang "Đang thuê".`, 'Giao máy');
  if (!ok) return;
  const changes = { status: 'Đang thuê' };
  if (!toISODate(r.rentDate)) changes.rentDate = joinDT(todayISO(), nowTime());
  try {
    const res = await withConflict('rentals', r, changes, (force) =>
      call('saveRental', { rental: { ...changes, id: r.id }, expectedUpdatedAt: r.updatedAt, force }));
    upsertLocal('rentals', res.rental);
    render();
    toast('Đã giao máy — đơn ' + r.id, 'ok');
  } catch (e) {
    toast(e.code === 'CANCELLED' ? e.message : 'Không lưu được: ' + e.message, e.code === 'CANCELLED' ? '' : 'err');
  }
}

/* ======================================================================
   FORM THIẾT BỊ & KHÁCH HÀNG
   ====================================================================== */
function historyHtml(list, title, sumText) {
  if (!list.length) return `<h3>${title}</h3><div class="muted">Chưa có đơn thuê nào.</div>`;
  return `<h3>${title} (${list.length})</h3>${sumText ? `<div class="sum">${sumText}</div>` : ''}<div class="list">` +
    list.map((r) => `<div class="hrow" data-rid="${esc(r.id)}">
      <span><b>${esc(r.id)}</b></span>
      <span>${esc(r.customerName)} · ${fmtDate(r.rentDate)} → ${fmtDate(r.returnedDate || r.returnDate)}</span>
      <span>${fmtMoney(r.total)}</span>
      <span>${rentalChip(r)}</span></div>`).join('') + '</div>';
}

function openDevice(d = null) {
  const form = $('#deviceForm');
  form.reset();
  $('#dState').innerHTML = DEVICE_STATES.map((s) => `<option>${s}</option>`).join('');
  const base = d || { state: 'Hoạt động' };
  state.df = { original: d ? { ...d } : null };
  KEYS.devices.forEach((k) => {
    if (k === 'price') setMoney(form.elements.price, base.price);
    else form.elements[k].value = base[k] ?? '';
  });
  if (!DEVICE_STATES.includes(base.state)) form.elements.state.value = 'Hoạt động';
  $('#dTitle').textContent = d ? 'Thiết bị: ' + d.name : 'Thêm thiết bị';
  $('#dMeta').textContent = d ? `Mã ${d.id} · Cập nhật ${fmtDateTime(d.updatedAt)} bởi ${d.updatedBy || '—'}` : '';
  $('#dDelete').classList.toggle('hidden', !d);
  $('#dRent').classList.toggle('hidden', !d);
  $('#dQtyWrap').classList.toggle('hidden', !!d);   // số lượng: chỉ khi thêm mới
  form.elements.qty.value = 1;
  const hist = d ? (state.idx.byDevice.get(d.id) || []) : [];
  // doanh thu ước tính từ thiết bị — tách theo chi nhánh, không cộng tổng
  const byBranch = new Map();
  hist.filter((r) => r.status !== 'Đã hủy' && countsRevenue(r)).forEach((r) => {
    const v = n0((r._items.find((i) => i.id === d.id) || {}).price) * n0(r.days);
    byBranch.set(r.branch || 'Chưa có chi nhánh', (byBranch.get(r.branch || 'Chưa có chi nhánh') || 0) + v);
  });
  const revText = [...byBranch].map(([b, v]) => (byBranch.size > 1 || state.me.owner ? `${esc(b)}: ` : '') + (fmtMoney(v) || '0 đ')).join(' · ');
  $('#dHistory').innerHTML = d ? historyHtml(hist, 'Lịch sử cho thuê', hist.length ? `Doanh thu ước tính từ thiết bị này — ${revText}` : '') : '';
  $('#dHistory').classList.toggle('hidden', !d);
  $('#dlgDevice').showModal();
  autoFocus(form.elements.name);
}

function openCustomer(c = null) {
  const form = $('#customerForm');
  form.reset();
  state.cf = { original: c ? { ...c } : null };
  KEYS.customers.forEach((k) => (form.elements[k].value = c ? c[k] ?? '' : ''));
  $('#cTitle').textContent = c ? 'Khách hàng: ' + c.name : 'Thêm khách hàng';
  $('#cMeta').textContent = c ? `Mã ${c.id} · Tạo ${fmtDateTime(c.createdAt)} · Cập nhật ${fmtDateTime(c.updatedAt)} bởi ${c.updatedBy || '—'}` : '';
  $('#cDelete').classList.toggle('hidden', !c);
  $('#cRent').classList.toggle('hidden', !c);
  if (c) {
    const s = customerStats(c);
    $('#cHistory').innerHTML = historyHtml(s.list, 'Lịch sử thuê', `Tổng chi: ${fmtMoney(s.spent) || '0 đ'}${s.due ? ` · <span class="due-text">Còn nợ: ${fmtMoney(s.due)}</span>` : ''}`);
  }
  $('#cHistory').classList.toggle('hidden', !c);
  $('#dlgCustomer').showModal();
  autoFocus(form.elements.name);
}

function readSimpleForm(table, form) {
  const o = {};
  KEYS[table].forEach((k) => {
    const v = form.elements[k].value.trim();
    o[k] = NUMERIC.includes(k) ? toNum(v) : v;
  });
  return o;
}

async function saveSimple(table, ev) {
  ev.preventDefault();
  const form = ev.target;
  const st = table === 'devices' ? state.df : state.cf;
  const data = readSimpleForm(table, form);
  if (!data.name) return toast('Vui lòng nhập tên', 'err');
  if (table === 'customers' && data.phone && digits(data.phone).length >= 8) {
    const dup = state.data.customers.find((c) => digits(c.phone) === digits(data.phone) && (!st.original || c.id !== st.original.id));
    if (dup && !(await confirmBox('SĐT bị trùng', `Số ${data.phone} đã thuộc khách "${dup.name}". Vẫn lưu?`, 'Vẫn lưu'))) return;
  }
  const btn = form.querySelector('[type=submit]');
  btn.disabled = true;
  try {
    let saved;
    const qty = table === 'devices' && !st.original ? Math.max(1, Math.min(50, Math.floor(Number(form.elements.qty.value)) || 1)) : 1;
    if (qty > 1) {
      // nhiều máy giống nhau: mỗi máy một thiết bị riêng, serial điền sau
      const res = await call('add', { table, item: { ...data, serial: '' }, qty });
      res.items.forEach((it) => upsertLocal(table, it));
      form.closest('dialog').close();
      render();
      return toast(`Đã thêm ${res.items.length} máy "${data.name}" — serial có thể điền sau cho từng máy`, 'ok');
    }
    if (!st.original) saved = (await call('add', { table, item: data })).item;
    else {
      const orig = st.original;
      const changes = Object.fromEntries(changedKeys(table, orig, data).map((k) => [k, data[k]]));
      if (!Object.keys(changes).length) { form.closest('dialog').close(); return toast('Không có thay đổi'); }
      saved = (await withConflict(table, orig, changes, (force) =>
        call('update', { table, item: { ...changes, id: orig.id }, expectedUpdatedAt: orig.updatedAt, force }))).item;
    }
    upsertLocal(table, saved);
    form.closest('dialog').close();
    render();
    toast('Đã lưu "' + saved.name + '"', 'ok');
  } catch (e) {
    if (e.code === 'CANCELLED') { form.closest('dialog').close(); toast(e.message); }
    else toast('Không lưu được: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function deleteRecord(table, item) {
  let msg;
  if (table === 'rentals') msg = `Xóa đơn ${item.id} của ${item.customerName}?\nĐơn sẽ bị xóa khỏi Google Sheet cho cả hai chi nhánh. Nếu chỉ muốn hủy, hãy đổi trạng thái sang "Đã hủy" để giữ lịch sử.`;
  else if (table === 'devices') {
    const n = (state.idx.byDevice.get(item.id) || []).length;
    msg = `Xóa thiết bị "${item.name}" khỏi danh mục?` + (n ? `\nThiết bị đã có ${n} đơn thuê — các đơn cũ vẫn giữ tên thiết bị. Nếu không dùng nữa, nên đổi tình trạng sang "Ngừng sử dụng".` : '');
  } else {
    const n = (state.idx.byCustomer.get(item.id) || []).length;
    msg = `Xóa khách hàng "${item.name}"?` + (n ? `\nKhách đã có ${n} đơn thuê — các đơn cũ vẫn giữ tên khách.` : '');
  }
  if (!(await confirmBox('Xác nhận xóa', msg, 'Xóa', true))) return false;
  try {
    try {
      await call('delete', { table, id: item.id, expectedUpdatedAt: item.updatedAt });
    } catch (e) {
      if (e.code !== 'CONFLICT') throw e;
      const cur = e.data.current;
      if (!(await confirmBox('Dữ liệu vừa bị thay đổi', `Bản ghi vừa được ${cur.updatedBy || 'người khác'} cập nhật lúc ${fmtDateTime(cur.updatedAt)}.\nVẫn xóa?`, 'Vẫn xóa', true))) {
        upsertLocal(table, cur);
        render();
        return false;
      }
      await call('delete', { table, id: item.id, force: true });
    }
    removeLocal(table, item.id);
    render();
    toast('Đã xóa', 'ok');
    return true;
  } catch (e) {
    toast('Không xóa được: ' + e.message, 'err');
    return false;
  }
}

/* ======================================================================
   CÀI ĐẶT, HƯỚNG DẪN, XUẤT FILE
   ====================================================================== */
function openSettings(first = false) {
  const f = $('#settingsForm');
  const s = state.settings;
  f.elements.url.value = s.url || '';
  f.elements.key.value = s.key || '';
  f.elements.user.value = s.user || '';
  f.elements.branch.value = s.branch || '';
  f.elements.refreshSec.value = s.refreshSec || 20;
  $('#testResult').textContent = first ? 'Chào bạn! Nhập thông tin kết nối một lần là dùng được mãi.' : '';
  $('#testResult').className = 'test';
  $('#dlgSettings').showModal();
  if (!f.elements.url.value) autoFocus(f.elements.url);
}

function readSettingsForm() {
  const f = $('#settingsForm');
  return {
    url: f.elements.url.value.trim(),
    key: f.elements.key.value,
    user: f.elements.user.value.trim(),
    branch: f.elements.branch.value.trim(),
    refreshSec: Math.min(600, Math.max(5, Number(f.elements.refreshSec.value) || 20)),
  };
}

async function testSettings() {
  const s = readSettingsForm();
  const out = $('#testResult');
  if (/docs\.google\.com\/(spreadsheets|document)/.test(s.url)) {
    out.className = 'test err';
    out.textContent = 'Đây là link file Google Sheet. Cần dán link Web App của Apps Script (kết thúc bằng /exec) — bấm Hướng dẫn để xem cách lấy.';
    return false;
  }
  out.className = 'test';
  out.textContent = 'Đang kiểm tra…';
  try {
    const p = await call('ping', {}, s);
    out.className = 'test ok';
    if (p.branch === undefined) {
      out.textContent = `✓ Kết nối được tới "${p.name}" — nhưng mã Apps Script là bản cũ, chưa tách doanh thu theo chi nhánh. Hãy dán lại mã mới (xem Hướng dẫn).`;
    } else {
      out.textContent = `✓ Kết nối thành công tới "${p.name}" — ` + (p.owner ? 'mã chủ: xem được mọi chi nhánh' : `chi nhánh: ${p.branch}`);
    }
    return true;
  } catch (e) {
    out.className = 'test err';
    out.textContent = '✗ ' + e.message;
    return false;
  }
}

async function saveSettings(ev) {
  ev.preventDefault();
  const s = readSettingsForm();
  const changedConn = s.url !== state.settings.url || s.key !== state.settings.key;
  state.settings = s;
  await sys.setSettings(s);
  $('#dlgSettings').close();
  if (changedConn) {
    state.data = { devices: [], customers: [], rentals: [] };
    state.since = '';
    state.lastSync = null;
    state.me = { branch: '', owner: true, legacy: true };
    state.sheetUrl = '';
  }
  render();
  connect();
}

function openGuide() {
  const frame = $('#guideFrame');
  if (!frame.src) frame.src = 'guide.html';
  $('#dlgGuide').showModal();
}

async function exportCsv() {
  const view = state.view;
  const list = listFor(view);
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  let head, rows;
  if (view === 'rentals') {
    head = ['Mã đơn', 'Trạng thái', 'Khách hàng', 'SĐT', 'Thiết bị', 'Ngày thuê', 'Ngày trả dự kiến', 'Ngày trả thực tế', 'Số ngày', 'Tạm tính', 'Giảm giá', 'Thành tiền', 'Tiền cọc', 'Thu trước', 'Còn phải thu', 'Trả lại khách', 'Chi nhánh', 'Ghi chú'];
    rows = list.map((r) => [r.id, isLate(r) ? 'Quá hạn' : r.status, r.customerName, r.phone, r.items, fmtDate(r.rentDate), fmtDate(r.returnDate), fmtDate(r.returnedDate), r.days, r.subtotal, r.discount, r.total, r.deposit, r.paid, due(r), refund(r), r.branch, r.note]);
  } else if (view === 'devices') {
    head = ['ID', 'Tên thiết bị', 'Loại', 'Serial / Mã', 'Giá thuê/ngày', 'Tình trạng', 'Đang ở chỗ', 'Ghi chú'];
    rows = list.map((d) => [d.id, d.name, d.category, d.serial, d.price, d._st.text, d._st.rental ? (d._st.rental.masked ? d._st.rental.branch : d._st.rental.customerName) : '', d.note]);
  } else {
    head = ['ID', 'Tên khách hàng', 'SĐT', 'CCCD', 'Địa chỉ', 'Số lần thuê', 'Tổng chi', 'Còn nợ', 'Lần thuê gần nhất', 'Ghi chú'];
    rows = list.map((c) => [c.id, c.name, c.phone, c.idCard, c.address, c._s.count, c._s.spent, c._s.due, fmtDate(c._s.last), c.note]);
  }
  const csv = [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const suffix = view === 'rentals' ? (state.period === 'month' ? state.month : state.period === 'active' ? 'dang-hoat-dong' : 'tat-ca') : todayISO();
  const name = { rentals: 'don-thue', devices: 'thiet-bi', customers: 'khach-hang' }[view];
  const p = await sys.exportCsv(`${name}-${suffix}.csv`, csv);
  if (p) toast('Đã xuất: ' + p, 'ok');
}

/* ================== Sự kiện ================== */
function setView(v) {
  state.view = v;
  render();
}

function bind() {
  document.querySelectorAll('select').forEach(enhanceSelect);
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b) setView(b.dataset.view); });
  $('#btnAdd').onclick = () => (state.view === 'rentals' ? openRental() : state.view === 'devices' ? openDevice() : openCustomer());
  $('#btnRefresh').onclick = () => refresh({ full: true });
  $('#btnSettings').onclick = () => openSettings();
  $('#btnGuide').onclick = openGuide;
  $('#settingsGuide').onclick = (e) => { e.preventDefault(); openGuide(); };
  $('#btnExport').onclick = exportCsv;
  $('#btnOpenSheet').onclick = () => (state.sheetUrl ? sys.openExternal(state.sheetUrl) : toast('Chưa kết nối Google Sheet', 'err'));
  // nút ⋯ trên điện thoại: mở / đóng danh sách nút phụ
  const more = $('#moreMenu');
  const setMore = (open) => { more.classList.toggle('open', open); $('#btnMore').setAttribute('aria-expanded', String(open)); };
  $('#btnMore').onclick = () => setMore(!more.classList.contains('open'));
  more.addEventListener('click', (e) => { if (e.target.closest('button')) setMore(false); });
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('#moreMenu, #btnMore')) setMore(false); });
  document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => b.closest('dialog').close()));

  // kỳ xem
  $('#periodSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-period]');
    if (!b) return;
    state.period = b.dataset.period;
    if (state.period !== 'active' && ACTIVE.includes(state.vf.rentals.f1)) state.vf.rentals.f1 = '';
    render();
  });
  $('#mPrev').onclick = () => { state.month = addMonths(state.month, -1); render(); };
  $('#mNext').onclick = () => { state.month = addMonths(state.month, 1); render(); };
  $('#mNow').onclick = () => { state.month = thisMonth(); render(); };
  // bảng chọn tháng (tiếng Việt — không dùng ô tháng của hệ điều hành)
  let mpYear = 0;
  const drawMonthPanel = () => {
    $('#mpYear').textContent = 'Năm ' + mpYear;
    const now = thisMonth();
    $('#mpGrid').innerHTML = Array.from({ length: 12 }, (_, i) => {
      const ym = `${mpYear}-${pad(i + 1)}`;
      return `<button type="button" data-ym="${ym}" class="${ym === state.month ? 'on' : ''} ${ym === now ? 'now' : ''}">Tháng ${i + 1}</button>`;
    }).join('');
  };
  const toggleMonthPanel = (open) => {
    const p = $('#monthPanel');
    open = open ?? p.classList.contains('hidden');
    if (open) { mpYear = Number(state.month.slice(0, 4)); drawMonthPanel(); }
    p.classList.toggle('hidden', !open);
    $('#monthBtn').setAttribute('aria-expanded', String(open));
  };
  $('#monthBtn').onclick = () => toggleMonthPanel();
  $('#mpYPrev').onclick = () => { mpYear--; drawMonthPanel(); };
  $('#mpYNext').onclick = () => { mpYear++; drawMonthPanel(); };
  $('#mpGrid').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-ym]');
    if (!b) return;
    state.month = b.dataset.ym;
    toggleMonthPanel(false);
    render();
  });
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('.mp-wrap')) toggleMonthPanel(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleMonthPanel(false); });

  // lọc
  $('#q').addEventListener('input', (e) => { state.vf[state.view].q = e.target.value; render(); });
  $('#f1').addEventListener('change', (e) => { state.vf[state.view].f1 = e.target.value; render(); });
  $('#f2').addEventListener('change', (e) => { state.vf[state.view].f2 = e.target.value; render(); });
  $('#stats').addEventListener('click', (e) => {
    const br = e.target.closest('.stat[data-branch]');
    if (br) { state.vf.rentals.f2 = br.dataset.branch; render(); return; }
    const b = e.target.closest('.stat[data-f1]');
    if (!b) return;
    const f = state.vf[state.view];
    f.f1 = f.f1 === b.dataset.f1 ? '' : b.dataset.f1;
    render();
  });
  $('#thead').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const s = state.sort[state.view], k = th.dataset.sort;
    state.sort[state.view] = { key: k, desc: s.key === k ? !s.desc : ['rentDate', 'last', 'count', 'spent', 'due', 'total', 'paid', 'subtotal'].includes(k) };
    render();
  });

  // bảng
  $('#tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const id = tr.dataset.id;
    const act = e.target.closest('[data-act]');
    const a = act && act.dataset.act;
    if (state.view === 'rentals') {
      const r = state.data.rentals.find((x) => x.id === id);
      if (!r) return;
      if (a === 'deliver') deliverRental(r);
      else if (a === 'payfull') payFull(r);
      else if (a === 'return') openRental(r, { title: 'Trả máy', fields: { status: 'Đã trả' }, focus: 'paid' });
      else openRental(r);
    } else if (state.view === 'devices') {
      const d = state.data.devices.find((x) => x.id === id);
      if (!d) return;
      if (a === 'rent') openRental(null, { devices: [d] });
      else openDevice(d);
    } else {
      const c = state.data.customers.find((x) => x.id === id);
      if (!c) return;
      if (a === 'rent') openRental(null, { customer: c });
      else openCustomer(c);
    }
  });

  // form đơn thuê
  $('#rentalForm').addEventListener('submit', submitRental);
  const f = rForm();
  [f.rentDate, f.returnDate, f.returnedDate].forEach((el) => el.addEventListener('change', onDatesChanged));
  [f.rentTime, f.returnTime, f.returnedTime].forEach((el) => {
    el.addEventListener('change', () => { const t = normTime(el.value); if (t) el.value = t; onDatesChanged(); });
  });
  f.branch.addEventListener('change', renderBranchTag);
  f.status.addEventListener('change', () => {
    if (f.status.value === 'Đã trả' && !f.returnedDate.value) { f.returnedDate.value = todayISO(); f.returnedTime.value = nowTime(); }
    if (f.status.value === 'Đang thuê' && !f.rentDate.value) { f.rentDate.value = todayISO(); f.rentTime.value = nowTime(); }
    onDatesChanged();
  });
  f.days.addEventListener('input', () => { state.rf.daysManual = true; renderSummary(); });
  ['discount', 'deposit', 'paid'].forEach((k) => f[k].addEventListener('input', renderSummary));
  // tick "Đã thu đủ": tự điền Thu trước; bỏ tick → trả lại số cũ; tự gõ vào Thu trước → bỏ tick
  $('#rPaidFull').addEventListener('change', (e) => {
    if (e.target.checked) state.rf.paidBefore = f.paid.value;
    else setMoney(f.paid, state.rf.paidBefore);
    renderSummary();
  });
  f.paid.addEventListener('input', () => {
    const pf = $('#rPaidFull');
    if (pf.checked) { pf.checked = false; state.rf.paidBefore = f.paid.value; renderSummary(); }
  }, true);
  $('#rDelete').onclick = async () => {
    const r = state.rf && state.rf.original;
    if (r && (await deleteRecord('rentals', r))) $('#dlgRental').close();
  };

  const cn = $('#custName');
  cn.addEventListener('input', () => {
    if (state.rf.customer && cn.value.trim() !== state.rf.customer.name) state.rf.customer = null;
    showSuggest();
    renderCustBadge();
  });
  cn.addEventListener('focus', showSuggest);
  cn.addEventListener('blur', () => setTimeout(hideSuggest, 150));
  cn.addEventListener('keydown', (e) => {
    const box = $('#custSuggest');
    const opts = [...box.querySelectorAll('.opt')];
    if (box.classList.contains('hidden') || !opts.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sugIndex = (sugIndex + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
      opts.forEach((o, i) => o.classList.toggle('hl', i === sugIndex));
    } else if (e.key === 'Enter' && sugIndex >= 0) {
      e.preventDefault();
      selectCustomer(state.data.customers.find((c) => c.id === opts[sugIndex].dataset.id));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      hideSuggest();
    }
  });
  $('#custSuggest').addEventListener('mousedown', (e) => {
    const o = e.target.closest('.opt');
    if (!o) return;
    e.preventDefault();
    selectCustomer(state.data.customers.find((c) => c.id === o.dataset.id));
  });
  $('#custPhone').addEventListener('input', renderCustBadge);

  $('#devSearch').addEventListener('input', renderPicker);
  $('#devSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = $('#devPicker .pick');
      if (first) { toggleDevice(first.dataset.id); $('#devSearch').select(); }
    }
  });
  $('#devPicker').addEventListener('click', (e) => { const p = e.target.closest('.pick'); if (p) toggleDevice(p.dataset.id); });
  $('#selList').addEventListener('click', (e) => {
    if (!e.target.classList.contains('x')) return;
    const k = Number(e.target.closest('.sel-row').dataset.k);
    state.rf.items.splice(k, 1);
    renderPicker();
    renderSelected();
  });
  $('#selList').addEventListener('input', (e) => {
    if (!e.target.classList.contains('sel-price')) return;
    const k = Number(e.target.closest('.sel-row').dataset.k);
    state.rf.items[k].price = toNum(e.target.value);
    setMoney(e.target, e.target.value);
    renderSummary();
  });

  // form thiết bị & khách
  $('#deviceForm').addEventListener('submit', (e) => saveSimple('devices', e));
  $('#customerForm').addEventListener('submit', (e) => saveSimple('customers', e));
  $('#dDelete').onclick = async () => { if (state.df.original && (await deleteRecord('devices', state.df.original))) $('#dlgDevice').close(); };
  $('#cDelete').onclick = async () => { if (state.cf.original && (await deleteRecord('customers', state.cf.original))) $('#dlgCustomer').close(); };
  $('#dRent').onclick = () => { const d = state.df.original; $('#dlgDevice').close(); openRental(null, { devices: [d] }); };
  $('#cRent').onclick = () => { const c = state.data.customers.find((x) => x.id === state.cf.original.id) || state.cf.original; $('#dlgCustomer').close(); openRental(null, { customer: c }); };
  ['#dHistory', '#cHistory'].forEach((sel) => $(sel).addEventListener('click', (e) => {
    const row = e.target.closest('[data-rid]');
    if (!row) return;
    const r = state.data.rentals.find((x) => x.id === row.dataset.rid);
    if (!r) return;
    e.target.closest('dialog').close();
    openRental(r);
  }));
  document.querySelectorAll('.money').forEach((el) => el.addEventListener('input', () => setMoney(el, el.value)));

  // cài đặt
  $('#settingsForm').addEventListener('submit', saveSettings);
  $('#btnTest').onclick = testSettings;

  // phím tắt
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    if (mod && k === 'n') { e.preventDefault(); $('#btnAdd').click(); }
    else if (mod && k === 'f') { e.preventDefault(); $('#q').focus(); $('#q').select(); }
    else if (mod && ['1', '2', '3'].includes(k)) { e.preventDefault(); setView(['rentals', 'devices', 'customers'][Number(k) - 1]); }
    else if (e.key === 'F5' || (mod && k === 'r')) { e.preventDefault(); refresh({ full: true }); }
  });

  window.addEventListener('focus', () => {
    if (state.lastSync && Date.now() - state.lastSync.getTime() > 5000) refresh({ silent: true });
  });
}

async function init() {
  state.month = thisMonth();
  state.settings = { refreshSec: 20, ...(await sys.getSettings()) };
  const cache = await sys.getCache();
  // dữ liệu lưu tạm chỉ dùng lại khi cùng link VÀ cùng mã (mã khác = chi nhánh khác)
  if (cache && cache.data && cache.url === state.settings.url && (cache.key === undefined || cache.key === state.settings.key)) {
    state.data = { devices: [], customers: [], rentals: [], ...cache.data };
    state.cacheAt = cache.savedAt;
    if (cache.me) state.me = cache.me;
  }
  bind();
  render();
  updateSync();
  if (!state.settings.url) openSettings(true);
  else connect();
}

init();

/* Web app: lưu sẵn giao diện để mở được cả khi mạng chập chờn (chỉ khi chạy trên trình duyệt, không phải app máy tính) */
if (!window.api && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => { /* bỏ qua */ }));
}
