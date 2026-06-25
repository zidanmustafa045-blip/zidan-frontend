/* =====================================================================
   AgriVision Ultra — api.js
   طبقة الربط بين واجهة الموقع (agrivision_ultra.html) والـ Backend الحقيقي
   (FastAPI على http://localhost:8000). هذا الملف لا يلمس أي عنصر HTML،
   بل يعيد تعريف دوال الـ JavaScript الحية (calcFeas, refreshPrices,
   initPCharts, getRec, detectPest, calcFert, getWeather, initAll) بعد
   تحميل السكريبت الأصلي، فتُستبدل تلقائياً نسخها القديمة (الوهمية).
   ===================================================================== */

const API_BASE = window.AGRIVISION_API_BASE || 'http://localhost:8000';

/* ---------------------------------------------------------------------
   1) الجلسة والتوكن (JWT)
   --------------------------------------------------------------------- */
function getToken() { return localStorage.getItem('av_token'); }
function getUser() {
  try { return JSON.parse(localStorage.getItem('av_user')); }
  catch (e) { return null; }
}
function isLoggedIn() { return !!getToken(); }
function setSession(token, user) {
  localStorage.setItem('av_token', token);
  localStorage.setItem('av_user', JSON.stringify(user));
}
function clearSession() {
  localStorage.removeItem('av_token');
  localStorage.removeItem('av_user');
}

/* ---------------------------------------------------------------------
   2) طبقة الاتصال العامة بالـ API
   --------------------------------------------------------------------- */
async function apiFetch(path, opts = {}) {
  const headers = opts.headers || {};
  let body = opts.body;

  if (opts.isForm) {
    // FormData: لا نحدد Content-Type يدوياً، المتصفح يضبطه مع boundary
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }

  if (opts.auth !== false && getToken()) {
    headers['Authorization'] = 'Bearer ' + getToken();
  }

  const res = await fetch(API_BASE + path, {
    method: opts.method || 'GET',
    headers,
    body,
  });

  if (res.status === 401) {
    clearSession();
    updateUserCardUI();
    throw new Error('انتهت صلاحية الجلسة، سجّل الدخول مرة أخرى');
  }

  if (!res.ok) {
    let msg = 'حدث خطأ في الاتصال بالخادم (' + res.status + ')';
    try {
      const j = await res.json();
      if (j && j.detail) msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
    } catch (e) { /* تجاهل */ }
    throw new Error(msg);
  }

  if (res.status === 204) return null;
  return res.json();
}

async function loginRequest(email, password) {
  const form = new URLSearchParams();
  form.append('username', email);
  form.append('password', password);
  const res = await fetch(API_BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (!res.ok) {
    let msg = 'فشل تسجيل الدخول، تحقق من البريد وكلمة المرور';
    try { const j = await res.json(); if (j.detail) msg = j.detail; } catch (e) {}
    throw new Error(msg);
  }
  return res.json();
}

async function registerRequest(payload) {
  return apiFetch('/api/auth/register', { method: 'POST', auth: false, body: payload });
}

/* ---------------------------------------------------------------------
   3) بيانات مرجعية (محافظات / أنواع تربة / مصادر مياه / محاصيل)
   --------------------------------------------------------------------- */
let LOOKUPS = { governorates: {}, soil_types: {}, water_sources: {}, crops: {}, cropsById: {} };
let lookupsLoaded = false;
let lookupsPromise = null;

function fetchLookups() {
  if (lookupsPromise) return lookupsPromise;
  lookupsPromise = (async () => {
    try {
      const [govs, soils, waters, crops] = await Promise.all([
        apiFetch('/api/governorates', { auth: false }),
        apiFetch('/api/soil-types', { auth: false }),
        apiFetch('/api/water-sources', { auth: false }),
        apiFetch('/api/crops', { auth: false }),
      ]);
      govs.forEach(g => LOOKUPS.governorates[g.code] = g);
      soils.forEach(s => LOOKUPS.soil_types[s.code] = s);
      waters.forEach(w => LOOKUPS.water_sources[w.code] = w);
      crops.forEach(c => { LOOKUPS.crops[c.code] = c; LOOKUPS.cropsById[c.id] = c; });
      rebuildWCitySelect();
      lookupsLoaded = true;
    } catch (err) {
      console.error('فشل تحميل البيانات المرجعية من الـ API:', err);
      toast('تعذر الاتصال بالخادم المحلي (localhost:8000) — تأكد أنه يعمل', 'err');
    }
  })();
  return lookupsPromise;
}

async function ensureLookups() {
  if (!lookupsLoaded) await fetchLookups();
}

// يستبدل خيارات قائمة المحافظات في قسم الطقس (كانت بصيغة "lat,lon" وهمية)
// بأكواد المحافظات الحقيقية القادمة من /api/governorates
function rebuildWCitySelect() {
  const sel = document.getElementById('wCity');
  if (!sel) return;
  sel.innerHTML = '';
  Object.values(LOOKUPS.governorates).forEach(g => {
    const opt = document.createElement('option');
    opt.value = g.code;
    opt.textContent = g.name_ar;
    sel.appendChild(opt);
  });
  if (LOOKUPS.governorates['cairo']) sel.value = 'cairo';
}

/* ---------------------------------------------------------------------
   4) نافذة تسجيل الدخول / إنشاء حساب (تُحقن في الصفحة تلقائياً)
   --------------------------------------------------------------------- */
let authMode = 'login';

function injectAuthModal() {
  if (document.getElementById('authOverlay')) return;

  const style = document.createElement('style');
  style.textContent = `
    #authOverlay{position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:7000;display:none;align-items:center;justify-content:center;}
    #authOverlay.show{display:flex;}
    #authBox{background:var(--card);border-radius:var(--r);padding:1.5rem;width:380px;max-width:90vw;box-shadow:var(--shadow2);}
  `;
  document.head.appendChild(style);

  const div = document.createElement('div');
  div.id = 'authOverlay';
  div.innerHTML = `
    <div id="authBox">
      <h3 id="authTitle" style="color:var(--p);margin-bottom:1rem;">تسجيل الدخول</h3>
      <div class="form-g" id="authNameGroup" style="display:none;"><label>الاسم الكامل</label><input id="authName" type="text"></div>
      <div class="form-g"><label>البريد الإلكتروني</label><input id="authEmail" type="email"></div>
      <div class="form-g"><label>كلمة المرور</label><input id="authPassword" type="password"></div>
      <button class="btn btn-p btn-block" id="authSubmitBtn" onclick="submitAuth()">دخول</button>
      <p style="text-align:center;margin-top:0.8rem;font-size:0.85rem;">
        <a href="#" id="authToggleLink" onclick="toggleAuthMode();return false;">ليس لديك حساب؟ سجل الآن</a>
      </p>
      <button class="btn btn-o btn-block" style="margin-top:0.5rem;" onclick="closeAuthModal()">إغلاق</button>
    </div>`;
  document.body.appendChild(div);
}

function openAuthModal() { injectAuthModal(); applyAuthModeUI(); document.getElementById('authOverlay').classList.add('show'); }
function closeAuthModal() { const o = document.getElementById('authOverlay'); if (o) o.classList.remove('show'); }

// يحدّث كل عناصر النافذة (العنوان، حقل الاسم، نص الزر، نص رابط التبديل) حسب الوضع الحالي (login/register)
function applyAuthModeUI() {
  const isRegister = authMode === 'register';
  const title = document.getElementById('authTitle');
  const nameGroup = document.getElementById('authNameGroup');
  const submitBtn = document.getElementById('authSubmitBtn');
  const toggleLink = document.getElementById('authToggleLink');
  if (title) title.textContent = isRegister ? 'حساب جديد' : 'تسجيل الدخول';
  if (nameGroup) nameGroup.style.display = isRegister ? 'block' : 'none';
  if (submitBtn) submitBtn.textContent = isRegister ? 'إنشاء حساب' : 'دخول';
  if (toggleLink) toggleLink.textContent = isRegister ? 'لديك حساب؟ سجل الدخول' : 'ليس لديك حساب؟ سجل الآن';
}

function toggleAuthMode() {
  authMode = authMode === 'login' ? 'register' : 'login';
  applyAuthModeUI();
}

async function submitAuth() {
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  if (!email || !password) { toast('أدخل البريد الإلكتروني وكلمة المرور', 'err'); return; }

  const submitBtn = document.getElementById('authSubmitBtn');
  if (submitBtn) submitBtn.disabled = true;

  try {
    if (authMode === 'register') {
      // ----- إنشاء حساب جديد -----
      const name = document.getElementById('authName').value.trim();
      if (!name) { toast('أدخل الاسم الكامل', 'err'); return; }

      try {
        await registerRequest({ full_name: name, email, password });
      } catch (err) {
        const msg = (err.message || '').includes('مسجل') ? 'البريد مستخدم من قبل' : (err.message || 'فشل إنشاء الحساب');
        toast(msg, 'err');
        return;
      }

      toast('تم إنشاء الحساب بنجاح، يتم تسجيل دخولك...', 'ok');

      try {
        const tok = await loginRequest(email, password);
        setSession(tok.access_token, tok.user);
        updateUserCardUI();
        closeAuthModal();
        toast('تم تسجيل الدخول بنجاح', 'ok');
      } catch (err) {
        // الحساب تم إنشاؤه فعلاً، لكن تسجيل الدخول التلقائي فشل لسبب آخر (لا نعرض رسالة "بيانات خاطئة" المضللة هنا)
        toast('تم إنشاء حسابك، رجاءً سجّل الدخول الآن', 'warn');
        authMode = 'login';
        applyAuthModeUI();
      }
    } else {
      // ----- تسجيل الدخول -----
      const tok = await loginRequest(email, password);
      setSession(tok.access_token, tok.user);
      updateUserCardUI();
      closeAuthModal();
      toast('تم تسجيل الدخول بنجاح', 'ok');
    }
  } catch (err) {
    toast(err.message || 'فشلت العملية', 'err');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function userCardClick() {
  if (isLoggedIn()) {
    if (confirm('تسجيل الخروج من الحساب؟')) {
      clearSession();
      updateUserCardUI();
      toast('تم تسجيل الخروج', 'ok');
    }
  } else {
    authMode = 'login';
    openAuthModal();
  }
}

function updateUserCardUI() {
  const card = document.querySelector('.user-card');
  if (!card) return;
  const info = card.querySelector('.user-info');
  if (!info) return;
  const u = getUser();
  info.innerHTML = u
    ? `<div style="font-weight:700;font-size:0.85rem;">${u.full_name}</div><div style="font-size:0.7rem;color:var(--muted);">${u.role}</div>`
    : `<div style="font-weight:700;font-size:0.85rem;">تسجيل الدخول</div><div style="font-size:0.7rem;color:var(--muted);">غير مسجل</div>`;
}

/* ---------------------------------------------------------------------
   5) دراسة الجدوى — POST /api/feasibility (تتطلب تسجيل الدخول)
   --------------------------------------------------------------------- */
const FEAS_FIXED_CATS = ['إعداد الأرض', 'شبكة الري', 'معدات وآلات', 'مباني ومخازن', 'كهرباء وتوصيلات', 'طرق وسياج'];
const FEAS_VAR_CATS = ['بذور/شتلات', 'أسمدة', 'مبيدات', 'أجور عمالة', 'وقود/كهرباء', 'نقل وتسويق', 'مياه ري', 'تعبئة وتخزين'];

async function calcFeas() {
  const cropCode = document.getElementById('fCrop').value;
  const area = parseFloat(document.getElementById('fArea').value);
  if (!cropCode) { toast('اختر المحصول أولاً', 'err'); return; }
  if (!area || area <= 0) { toast('أدخل مساحة صحيحة بالفدان', 'err'); return; }
  if (!isLoggedIn()) { toast('سجّل الدخول لحساب الجدوى وحفظ الدراسة', 'warn'); openAuthModal(); return; }

  await ensureLookups();

  const govCode = document.getElementById('fGov').value;
  const soilCode = document.getElementById('fSoil').value;
  const waterCode = document.getElementById('fWater').value;
  const season = document.getElementById('fSeason').value;

  const costItems = [];
  document.querySelectorAll('.fc[data-t="fixed"]').forEach((el, i) => {
    const v = parseFloat(el.value);
    if (v > 0) costItems.push({ cost_type: 'fixed', category: FEAS_FIXED_CATS[i] || ('ثابت ' + (i + 1)), amount: v });
  });
  document.querySelectorAll('.fc[data-t="var"]').forEach((el, i) => {
    const v = parseFloat(el.value);
    if (v > 0) costItems.push({ cost_type: 'variable', category: FEAS_VAR_CATS[i] || ('متغير ' + (i + 1)), amount: v });
  });

  const payload = {
    crop_code: cropCode,
    governorate_id: LOOKUPS.governorates[govCode] ? LOOKUPS.governorates[govCode].id : null,
    soil_type_id: LOOKUPS.soil_types[soilCode] ? LOOKUPS.soil_types[soilCode].id : null,
    water_source_id: LOOKUPS.water_sources[waterCode] ? LOOKUPS.water_sources[waterCode].id : null,
    season: season,
    area_feddan: area,
    cost_items: costItems,
  };

  try {
    const study = await apiFetch('/api/feasibility', { method: 'POST', body: payload });
    renderFeasResult(study);
    showTab('f3', document.querySelectorAll('#feas .tab-btn')[2]);
  } catch (err) {
    toast('فشل حساب الجدوى: ' + err.message, 'err');
  }
}

function renderFeasResult(study) {
  const r = study.result;
  const box = document.getElementById('feasRes');
  if (!r) { box.innerHTML = '<p>لم يتمكن الخادم من حساب النتيجة.</p>'; return; }
  const crop = LOOKUPS.cropsById[study.crop_id] || { name_ar: '', emoji: '' };
  const profitable = r.is_profitable;
  box.innerHTML = `
  <div style="text-align:center;margin-bottom:1.5rem;"><h2 style="color:${profitable ? 'var(--p3)' : 'var(--d)'};font-size:2.2rem;">${profitable ? '✅ المشروع مربح' : '⚠️ يحتاج مراجعة'}</h2><p style="font-size:1.1rem;margin-top:0.5rem;">صافي الربح: <b style="color:${profitable ? 'var(--p3)' : 'var(--d)'};font-size:1.5rem;">${r.net_profit.toLocaleString()} ج.م</b></p></div>
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:1rem;margin-bottom:1.5rem;">
  <div style="background:var(--iL);padding:1rem;border-radius:12px;text-align:center;"><div style="font-size:0.8rem;color:var(--muted);">الإنتاج</div><div style="font-size:1.6rem;font-weight:800;color:var(--i);">${r.expected_production_kg.toLocaleString()} كجم</div></div>
  <div style="background:var(--pL);padding:1rem;border-radius:12px;text-align:center;"><div style="font-size:0.8rem;color:var(--muted);">الإيرادات</div><div style="font-size:1.6rem;font-weight:800;color:var(--p);">${r.expected_revenue.toLocaleString()} ج.م</div></div>
  <div style="background:var(--sL);padding:1rem;border-radius:12px;text-align:center;"><div style="font-size:0.8rem;color:var(--muted);">العائد</div><div style="font-size:1.6rem;font-weight:800;color:var(--s);">${r.roi_percent.toFixed(1)}%</div></div>
  <div style="background:var(--dL);padding:1rem;border-radius:12px;text-align:center;"><div style="font-size:0.8rem;color:var(--muted);">الاسترداد</div><div style="font-size:1.6rem;font-weight:800;color:var(--d);">${r.payback_months ? r.payback_months.toFixed(1) : '-'} شهر</div></div>
  </div>
  <div style="background:var(--bg);padding:1.2rem;border-radius:12px;">
  <h4 style="color:var(--p);margin-bottom:0.8rem;">📋 توصيات AI:</h4>
  <ul style="padding-right:1.2rem;line-height:2;font-size:0.9rem;">
  <li>المحصول: <b>${crop.emoji || ''} ${crop.name_ar || ''}</b></li>
  <li>التكلفة الثابتة: <b>${r.total_fixed_cost.toLocaleString()} ج.م</b> — المتغيرة: <b>${r.total_variable_cost.toLocaleString()} ج.م</b></li>
  <li>إجمالي التكلفة: <b>${r.total_cost.toLocaleString()} ج.م</b> (${r.cost_per_feddan.toLocaleString()} ج.م/فدان)</li>
  <li>${r.ai_recommendation || (profitable ? '✅ أنصح بالمضي في المشروع' : '⚠️ راجع التكاليف أو اختر محصول بديل')}</li>
  </ul>
  </div>
  <div style="text-align:center;margin-top:1rem;">
  <button class="btn btn-p" onclick="toast('الدراسة محفوظة في حسابك على الخادم','ok')"><i>💾</i> محفوظة</button>
  <button class="btn btn-o" onclick="window.print()"><i>🖨️</i> طباعة</button>
  <button class="btn btn-s" onclick="showTab('f1',document.querySelectorAll('#feas .tab-btn')[0]);toast('تم إعادة البدء','ok')"><i>🔄</i> جديد</button>
  </div>`;
}

/* ---------------------------------------------------------------------
   6) الأسعار — GET /api/prices (عام) + POST /api/prices/refresh (أدمن/مهندس زراعي)
   --------------------------------------------------------------------- */
let pChart1Instance = null;
let pChart2Instance = null;

async function refreshPrices() {
  const b = document.getElementById('pBody');
  b.innerHTML = '<tr><td colspan="7" style="padding:2rem;"><div style="text-align:center;"><div class="load" style="margin:0 auto;width:30px;height:30px;border-width:2px;"></div></div></td></tr>';

  const u = getUser();
  if (isLoggedIn() && u && ['admin', 'agronomist'].includes(u.role)) {
    try { await apiFetch('/api/prices/refresh', { method: 'POST' }); } catch (e) { /* تجاهل غياب الصلاحية */ }
  }

  try {
    const list = await apiFetch('/api/prices', { auth: false });
    let h = '';
    list.forEach(v => {
      const ch = v.change_percent;
      const tr = v.trend === 'up' ? 'up' : v.trend === 'down' ? 'down' : '';
      const ic = v.trend === 'up' ? '↗' : v.trend === 'down' ? '↘' : '→';
      const stBg = v.status === 'ممتاز' ? 'var(--pL)' : (v.status === 'حذر' ? 'var(--dL)' : 'var(--sL)');
      const stColor = v.status === 'ممتاز' ? 'var(--p)' : (v.status === 'حذر' ? 'var(--d)' : 'var(--s)');
      h += `<tr><td><b>${v.crop_emoji || ''} ${v.crop_name_ar}</b></td><td>${v.price.toFixed(1)} ج.م</td><td class="${tr}">${ic} ${Math.abs(ch).toFixed(1)}%</td><td class="${tr}">${ch > 0 ? 'ارتفاع' : ch < 0 ? 'انخفاض' : 'مستقر'}</td><td>${v.high_price != null ? v.high_price.toFixed(1) : '-'}</td><td>${v.low_price != null ? v.low_price.toFixed(1) : '-'}</td><td><span style="background:${stBg};color:${stColor};padding:0.2rem 0.6rem;border-radius:12px;font-size:0.75rem;font-weight:700;">${v.status}</span></td></tr>`;
    });
    b.innerHTML = h || '<tr><td colspan="7">لا توجد بيانات أسعار حالياً</td></tr>';
    initPCharts(list);
    toast('تم تحديث الأسعار من الخادم', 'ok');
  } catch (err) {
    b.innerHTML = '<tr><td colspan="7" style="color:var(--d);padding:1.5rem;">تعذر جلب الأسعار: ' + err.message + '</td></tr>';
    toast('فشل تحديث الأسعار', 'err');
  }
}

function initPCharts(list) {
  if (!list || !list.length) return;
  const labels = list.map(v => v.crop_name_ar);
  const prices = list.map(v => v.price);

  const c1 = document.getElementById('pChart1').getContext('2d');
  if (pChart1Instance) pChart1Instance.destroy();
  pChart1Instance = new Chart(c1, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'السعر الحالي (ج.م)', data: prices, backgroundColor: '#2e7d32' }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { rtl: true } } },
  });

  const c2 = document.getElementById('pChart2').getContext('2d');
  if (pChart2Instance) pChart2Instance.destroy();
  pChart2Instance = new Chart(c2, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: prices, backgroundColor: ['#2e7d32', '#f57c00', '#1565c0', '#c62828', '#7b1fa2', '#00695c', '#fbc02d', '#5d4037', '#0097a7', '#8d6e63'] }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', rtl: true } } },
  });
}

/* ---------------------------------------------------------------------
   7) توصية المحصول الذكية — POST /api/recommendations (تتطلب تسجيل دخول)
   --------------------------------------------------------------------- */
async function getRec() {
  if (!isLoggedIn()) { toast('سجّل الدخول لاستخدام التوصية الذكية', 'warn'); openAuthModal(); return; }
  const payload = {
    nitrogen: parseInt(document.getElementById('nR').value, 10),
    phosphorus: parseInt(document.getElementById('pR').value, 10),
    potassium: parseInt(document.getElementById('kR').value, 10),
    temperature: parseFloat(document.getElementById('tR').value),
    humidity: parseFloat(document.getElementById('hR').value),
    rainfall_mm: parseFloat(document.getElementById('rR').value),
  };
  try {
    const res = await apiFetch('/api/recommendations', { method: 'POST', body: payload });
    document.getElementById('recRes').innerHTML = `<h4 style="color:var(--p);margin-bottom:0.8rem;">🎯 التوصية: ${res.recommended_crop_name_ar || '-'}</h4><div style="background:var(--bg);padding:1rem;border-radius:8px;margin-bottom:0.8rem;"><div style="display:flex;justify-content:space-between;margin-bottom:0.3rem;"><span>نسبة الثقة</span><span style="font-weight:700;">${res.confidence}%</span></div><div style="background:var(--bg);height:8px;border-radius:4px;overflow:hidden;"><div style="background:linear-gradient(90deg,var(--p),var(--p3));height:100%;width:${res.confidence}%;border-radius:4px;transition:width 1s;"></div></div></div><p style="color:var(--muted);font-size:0.85rem;">${res.explanation}</p>`;
    document.getElementById('recRes').classList.add('show');
  } catch (err) {
    toast('فشل الحصول على التوصية: ' + err.message, 'err');
  }
}

/* ---------------------------------------------------------------------
   8) كشف الآفات بالصورة — POST /api/pests/detect (تتطلب تسجيل دخول)
   --------------------------------------------------------------------- */
async function detectPest(e) {
  const f = e.target.files[0];
  if (!f) return;
  if (!isLoggedIn()) { toast('سجّل الدخول لاستخدام كشف الآفات بالصورة', 'warn'); openAuthModal(); return; }
  if (!['image/jpeg', 'image/png', 'image/jpg'].includes(f.type)) { toast('الصورة يجب أن تكون JPG أو PNG', 'err'); return; }
  if (f.size > 5 * 1024 * 1024) { toast('حجم الصورة أكبر من 5MB', 'err'); return; }

  const r = document.getElementById('pestRes');
  r.innerHTML = '<div style="text-align:center;padding:1.5rem;"><div class="load" style="margin:0 auto;width:40px;height:40px;"></div><p>جاري تحليل الصورة بالـ AI...</p></div>';

  const cropCode = document.getElementById('fCrop') ? document.getElementById('fCrop').value : '';
  const fd = new FormData();
  fd.append('image', f);
  let url = '/api/pests/detect';
  if (cropCode) url += '?crop_code=' + encodeURIComponent(cropCode);

  try {
    const res = await apiFetch(url, { method: 'POST', body: fd, isForm: true });
    const p = res.pest;
    if (p) {
      r.innerHTML = `<div style="background:var(--dL);border-right:4px solid var(--d);padding:1rem;border-radius:8px;"><h4 style="color:var(--d);margin-bottom:0.3rem;">${p.icon || '🐛'} ${p.name_ar}</h4><p style="font-size:0.85rem;margin-bottom:0.3rem;"><b>الخطورة:</b> ${p.severity}</p><p style="font-size:0.85rem;"><b>الحل:</b> ${p.solution}</p>${res.confidence != null ? `<p style="font-size:0.8rem;color:var(--muted);">نسبة الثقة: ${res.confidence}%</p>` : ''}</div>`;
    } else {
      r.innerHTML = '<p>لم يتمكن النظام من تحديد آفة معينة في هذه الصورة.</p>';
    }
  } catch (err) {
    r.innerHTML = '<p style="color:var(--d);">فشل تحليل الصورة: ' + err.message + '</p>';
  }
}

/* ---------------------------------------------------------------------
   9) حاسبة السماد — POST /api/fertilizer/calculate (تتطلب تسجيل دخول)
   --------------------------------------------------------------------- */
async function calcFert() {
  if (!isLoggedIn()) { toast('سجّل الدخول لحساب جرعة السماد', 'warn'); openAuthModal(); return; }
  await ensureLookups();

  const cropCode = document.getElementById('frCrop').value;
  const age = parseInt(document.getElementById('frAge').value, 10) || 30;
  const color = document.getElementById('frColor').value;
  const soilCode = document.getElementById('frSoil').value;

  const payload = {
    crop_code: cropCode,
    crop_age_days: age,
    leaf_color: color,
    soil_type_id: LOOKUPS.soil_types[soilCode] ? LOOKUPS.soil_types[soilCode].id : null,
  };

  try {
    const res = await apiFetch('/api/fertilizer/calculate', { method: 'POST', body: payload });
    document.getElementById('fertRes').innerHTML = `<h4 style="color:var(--p);margin-bottom:0.5rem;">🧪 التوصية: ${res.fertilizer_type}</h4>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.8rem;margin-bottom:0.8rem;">
    <div style="background:var(--pL);padding:0.8rem;border-radius:8px;"><div style="font-size:0.75rem;color:var(--muted);">الكمية</div><div style="font-weight:700;">${res.amount_per_feddan}</div></div>
    <div style="background:var(--sL);padding:0.8rem;border-radius:8px;"><div style="font-size:0.75rem;color:var(--muted);">الموعد</div><div style="font-weight:700;">${res.timing}</div></div>
    </div>
    <p style="font-size:0.85rem;margin-bottom:0.3rem;"><b>عمر المحصول:</b> ${age} يوم — N:${res.recommended_n} P:${res.recommended_p} K:${res.recommended_k}</p>
    ${res.notes ? `<p style="color:var(--i);font-size:0.85rem;">${res.notes}</p>` : ''}`;
    document.getElementById('fertRes').classList.add('show');
  } catch (err) {
    toast('فشل حساب الجرعة: ' + err.message, 'err');
  }
}

/* ---------------------------------------------------------------------
   10) الطقس — GET /api/weather/{governorate_code} (عام، بدون تسجيل دخول)
   --------------------------------------------------------------------- */
async function getWeather() {
  const sel = document.getElementById('wCity');
  const code = sel ? sel.value : '';
  if (!code) return;
  const c = document.getElementById('wCurrent');
  c.innerHTML = '<div style="text-align:center;padding:2rem;"><div class="load" style="margin:0 auto;"></div></div>';
  try {
    const data = await apiFetch('/api/weather/' + encodeURIComponent(code), { auth: false });
    const cur = data.current;
    c.innerHTML = `<div class="w-row"><div class="w-card"><div class="w-val">${cur.temperature}°C</div><div class="w-lbl">${cur.condition_text}</div></div><div class="w-card v2"><div class="w-val">${cur.humidity != null ? cur.humidity : '-'}%</div><div class="w-lbl">الرطوبة</div></div><div class="w-card v3"><div class="w-val">${cur.wind_speed != null ? cur.wind_speed : '-'}</div><div class="w-lbl">كم/س رياح</div></div><div class="w-card v4"><div class="w-val">📍</div><div class="w-lbl">${cur.governorate_name_ar}</div></div></div>`;

    let fh = '<div class="w-row">';
    data.forecast.forEach(d => {
      const dn = new Date(d.date).toLocaleDateString('ar-EG', { weekday: 'long' });
      fh += `<div class="w-card" style="${d.rainfall_mm > 0 ? 'background:linear-gradient(135deg,#1565c0,#42a5f5);' : 'background:linear-gradient(135deg,var(--p),var(--p2));'}"><div class="w-lbl">${dn}</div><div class="w-val">${d.max_temp}°/${d.min_temp}°</div><div class="w-lbl">${d.rainfall_mm > 0 ? '🌧️ ' + d.rainfall_mm + 'mm' : '☀️ صافٍ'}</div></div>`;
    });
    fh += '</div>';
    document.getElementById('wForecast').innerHTML = fh;
  } catch (err) {
    c.innerHTML = '<div style="text-align:center;color:var(--d);padding:2rem;">⚠️ تعذر جلب الطقس: ' + err.message + '</div>';
  }
}

/* ---------------------------------------------------------------------
   11) التهيئة الكاملة — تستبدل initAll() الأصلية بالكامل
   --------------------------------------------------------------------- */
function initAll() {
  animVal('sv1', 0, 1250, 1500);
  animVal('sv2', 0, 45, 1500);
  initChart1();
  renderCrops('all');
  renderPests();
  renderAlerts();
  renderReports();

  const card = document.querySelector('.user-card');
  if (card && !card._avBound) {
    card.addEventListener('click', userCardClick);
    card._avBound = true;
  }
  updateUserCardUI();

  // يجب تحميل المحافظات أولاً (لإعادة بناء قائمة المدن في قسم الطقس)
  // قبل استدعاء الطقس، ثم نجلب الأسعار الحقيقية من الخادم
  fetchLookups().then(() => { getWeather(); });
  refreshPrices();
}

// ============================================================================
// ADMIN PANEL (لوحة تحكم الأدمن)
// ============================================================================
function isAdminUser(){
  const u = getUser();
  return !!(u && u.role === 'admin');
}

function applyAdminNavVisibility(){
  const navAdmin = document.getElementById('navAdminSection');
  if(!navAdmin) return;
  navAdmin.style.display = isAdminUser() ? '' : 'none';
}

async function loadAdminPanel(){
  if(!isLoggedIn()){
    openAuthModal();
    return;
  }
  if(!isAdminUser()){
    toast('هذه الصفحة مخصصة للأدمن فقط','err');
    return;
  }
  try{
    const [stats, users, ads] = await Promise.all([
      apiFetch('/api/admin/stats'),
      apiFetch('/api/admin/users'),
      apiFetch('/api/admin/ads'),
    ]);
    renderAdminStats(stats);
    renderAdminUsers(users);
    renderAdminAds(ads);
  }catch(e){
    toast(e.message || 'فشل تحميل لوحة الأدمن','err');
  }
}

function renderAdminStats(stats){
  const setTxt = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
  setTxt('admStatTotal', stats.total_users);
  setTxt('admStatActive', stats.active_users);
  setTxt('admStatInactive', stats.inactive_users);
  setTxt('admStatPendingAds', stats.pending_ads);
}

function renderAdminUsers(users){
  const body = document.getElementById('adminUsersBody');
  if(!body) return;
  const me = getUser();
  const roles = ['admin','agronomist','farmer','viewer'];
  body.innerHTML = users.map(u => {
    const isMe = me && me.id === u.id;
    const roleOptions = roles.map(r => `<option value="${r}" ${r===u.role?'selected':''}>${r}</option>`).join('');
    const statusBadge = u.is_active
      ? '<span style="color:var(--p);font-weight:700;">نشط</span>'
      : '<span style="color:var(--d);font-weight:700;">معطّل</span>';
    const toggleBtn = isMe
      ? ''
      : `<button class="btn btn-o btn-sm" onclick="toggleUserActive('${u.id}', ${!u.is_active})">${u.is_active ? 'تعطيل' : 'تفعيل'}</button>`;
    const delBtn = isMe
      ? ''
      : `<button class="btn btn-sm" style="background:var(--d);color:#fff;" onclick="deleteUserAdmin('${u.id}')">حذف</button>`;
    return `<tr>
      <td>${escapeHtml(u.full_name || '-')}</td>
      <td>${escapeHtml(u.email)}</td>
      <td><select onchange="changeUserRole('${u.id}', this.value)" style="padding:0.3rem 0.5rem;width:auto;" ${isMe ? 'disabled' : ''}>${roleOptions}</select></td>
      <td>${statusBadge}</td>
      <td style="display:flex;gap:0.4rem;flex-wrap:wrap;">${toggleBtn}${delBtn}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--muted);">لا يوجد مستخدمون</td></tr>';
}

function renderAdminAds(ads){
  const body = document.getElementById('adminAdsBody');
  if(!body) return;
  const statusLabel = { pending: 'قيد المراجعة', approved: 'مقبول', rejected: 'مرفوض' };
  const statusColor = { pending: 'var(--s)', approved: 'var(--p)', rejected: 'var(--d)' };
  body.innerHTML = ads.map(a => `<tr>
      <td>${escapeHtml(a.company_name)}</td>
      <td>${escapeHtml(a.title)}</td>
      <td>${escapeHtml(a.contact_email)}${a.contact_phone ? ' / ' + escapeHtml(a.contact_phone) : ''}</td>
      <td><span style="color:${statusColor[a.status] || 'var(--muted)'};font-weight:700;">${statusLabel[a.status] || a.status}</span></td>
      <td style="display:flex;gap:0.4rem;flex-wrap:wrap;">
        ${a.status !== 'approved' ? `<button class="btn btn-p btn-sm" onclick="updateAdStatus('${a.id}','approved')">قبول</button>` : ''}
        ${a.status !== 'rejected' ? `<button class="btn btn-o btn-sm" onclick="updateAdStatus('${a.id}','rejected')">رفض</button>` : ''}
        <button class="btn btn-sm" style="background:var(--d);color:#fff;" onclick="deleteAdAdmin('${a.id}')">حذف</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--muted);">لا توجد عروض حالياً</td></tr>';
}

async function toggleUserActive(userId, makeActive){
  try{
    await apiFetch(`/api/admin/users/${userId}`, { method: 'PATCH', body: { is_active: makeActive } });
    toast(makeActive ? 'تم تفعيل الحساب' : 'تم تعطيل الحساب', 'ok');
    loadAdminPanel();
  }catch(e){
    toast(e.message || 'فشل تحديث المستخدم', 'err');
  }
}

async function changeUserRole(userId, newRole){
  try{
    await apiFetch(`/api/admin/users/${userId}`, { method: 'PATCH', body: { role: newRole } });
    toast('تم تحديث الصلاحية', 'ok');
    loadAdminPanel();
  }catch(e){
    toast(e.message || 'فشل تحديث الصلاحية', 'err');
    loadAdminPanel();
  }
}

async function deleteUserAdmin(userId){
  if(!confirm('هل أنت متأكد من حذف هذا المستخدم نهائياً؟')) return;
  try{
    await apiFetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
    toast('تم حذف المستخدم', 'ok');
    loadAdminPanel();
  }catch(e){
    toast(e.message || 'فشل حذف المستخدم', 'err');
  }
}

async function updateAdStatus(adId, status){
  try{
    await apiFetch(`/api/admin/ads/${adId}`, { method: 'PATCH', body: { status } });
    toast(status === 'approved' ? 'تم قبول العرض' : 'تم رفض العرض', 'ok');
    loadAdminPanel();
  }catch(e){
    toast(e.message || 'فشل تحديث العرض', 'err');
  }
}

async function deleteAdAdmin(adId){
  if(!confirm('هل أنت متأكد من حذف هذا العرض نهائياً؟')) return;
  try{
    await apiFetch(`/api/admin/ads/${adId}`, { method: 'DELETE' });
    toast('تم حذف العرض', 'ok');
    loadAdminPanel();
  }catch(e){
    toast(e.message || 'فشل حذف العرض', 'err');
  }
}

async function submitAdRequest(){
  const company = document.getElementById('adCompany').value.trim();
  const contactName = document.getElementById('adContactName').value.trim();
  const contactEmail = document.getElementById('adContactEmail').value.trim();
  const contactPhone = document.getElementById('adContactPhone').value.trim();
  const title = document.getElementById('adTitle').value.trim();
  const message = document.getElementById('adMessage').value.trim();

  if(!company || !contactEmail || !title || !message){
    toast('يرجى تعبئة جميع الحقول المطلوبة (*)', 'err');
    return;
  }

  try{
    await apiFetch('/api/ads', {
      method: 'POST',
      body: {
        company_name: company,
        contact_name: contactName || null,
        contact_email: contactEmail,
        contact_phone: contactPhone || null,
        title: title,
        message: message,
      },
    });
    toast('تم إرسال عرضك بنجاح! سنقوم بمراجعته قريباً', 'ok');
    ['adCompany','adContactName','adContactEmail','adContactPhone','adTitle','adMessage'].forEach(id => {
      const el = document.getElementById(id);
      if(el) el.value = '';
    });
  }catch(e){
    toast(e.message || 'فشل إرسال العرض', 'err');
  }
}

function escapeHtml(str){
  if(str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Hook admin-nav visibility into the existing user-card refresh flow without
// touching its original body.
if(typeof updateUserCardUI === 'function'){
  const __origUpdateUserCardUI = updateUserCardUI;
  updateUserCardUI = function(){
    __origUpdateUserCardUI.apply(this, arguments);
    applyAdminNavVisibility();
  };
}
window.addEventListener('load', applyAdminNavVisibility);
document.addEventListener('DOMContentLoaded', applyAdminNavVisibility);

// إعادة التحقق من صلاحية المستخدم من السيرفر مباشرة عند التحميل (وليس فقط من
// النسخة المخزّنة محلياً) لضمان ظهور لوحة الأدمن فوراً بعد ترقية الحساب من
// قاعدة البيانات، دون الحاجة لتسجيل خروج/دخول يدوي.
async function refreshCurrentUserFromServer(){
  if(!isLoggedIn()) return;
  try{
    const fresh = await apiFetch('/api/auth/me');
    const token = getToken();
    setSession(token, fresh);
    updateUserCardUI();
  }catch(e){ /* تجاهل: التوكن قد يكون منتهياً، apiFetch تتعامل مع ذلك بالفعل */ }
}
window.addEventListener('load', refreshCurrentUserFromServer);
