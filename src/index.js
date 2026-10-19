/**
 * Cloudflare Workers + D1 Serverless 跨境电商地址采集中心
 * 
 * 核心功能：
 * 1. GET  /                   -> 现代化响应式 Web 大屏 (寄件人、收件人、物品信息完整分栏卡片展示)
 * 2. POST /api/receive        -> 接收客户端推送到云端的全字段数据，由 D1 数据库执行唯一指纹去重并写入
 * 3. GET  /api/records        -> 查询地址列表与统计信息 (支持搜索、分页、鉴权)
 * 4. GET  /api/export/csv     -> 导出包含 UTF-8 BOM 的 Excel 兼容 CSV 文件 (含寄件、收件与物品全字段)
 * 5. GET  /api/export/json    -> 导出完整结构化 JSON
 * 6. POST /api/delete         -> 删除指定记录
 * 7. POST /api/clear          -> 清空数据 (需二次确认)
 * 8. GET  /api/ping           -> 健康检测心跳
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-auth-token"
};

// ==========================================
// 辅助函数：鉴权、指纹计算与时间格式化
// ==========================================

function getAuthSecret(env) {
  return (env.ADMIN_PASSWORD || env.AUTH_TOKEN || "").trim();
}

function checkAuth(request, env, bodyObj = null) {
  const secret = getAuthSecret(env);
  if (!secret) {
    return true;
  }

  // 1. Authorization: Bearer <TOKEN>
  const authHeader = request.headers.get("Authorization") || "";
  if (authHeader.startsWith("Bearer ") && authHeader.slice(7).trim() === secret) {
    return true;
  }

  // 2. x-auth-token
  const customHeader = request.headers.get("x-auth-token") || "";
  if (customHeader.trim() === secret) {
    return true;
  }

  // 3. URL Query: ?token=... 或 ?pwd=...
  const url = new URL(request.url);
  const qToken = url.searchParams.get("token") || url.searchParams.get("auth_token") || url.searchParams.get("pwd") || "";
  if (qToken.trim() === secret) {
    return true;
  }

  // 4. Request Body
  if (bodyObj && (bodyObj.auth_token === secret || bodyObj.password === secret)) {
    return true;
  }

  return false;
}

function getBeijingTime() {
  const d = new Date();
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  const bj = new Date(utc + (3600000 * 8));
  const pad = n => String(n).padStart(2, '0');
  return `${bj.getFullYear()}-${pad(bj.getMonth() + 1)}-${pad(bj.getDate())} ${pad(bj.getHours())}:${pad(bj.getMinutes())}:${pad(bj.getSeconds())}`;
}

async function sha256Hex(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  const arr = Array.from(new Uint8Array(hash));
  return arr.map(b => b.toString(16).padStart(2, "0")).join("");
}

function cleanStr(val) {
  if (val === null || val === undefined) return "";
  return String(val).trim();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS
    }
  });
}

// ==========================================
// 核心路由分发
// ==========================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    // CORS 预检
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 1. 首页 Dashboard
    if (path === "/" || path === "/index.html") {
      const isPwdSet = Boolean(getAuthSecret(env));
      return new Response(renderDashboardHtml(isPwdSet, env.APP_TITLE || "远程跨境运单采集中心"), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // 2. 心跳检测 (公开无鉴权)
    if (path === "/api/ping") {
      return jsonResponse({
        status: "ok",
        message: "pong",
        service: "Cloudflare Workers + D1",
        time: getBeijingTime(),
        password_required: Boolean(getAuthSecret(env))
      });
    }

    // 3. 密码验证接口
    if (path === "/api/auth/verify" && method === "POST") {
      let body = {};
      try { body = await request.json(); } catch(e) {}
      const authorized = checkAuth(request, env, body);
      if (authorized) {
        return jsonResponse({ status: "ok", authorized: true });
      }
      return jsonResponse({ status: "error", message: "密码错误，请重新输入" }, 401);
    }

    // 4. 数据接收接口 (POST /api/receive 或 POST /api/parse_and_save)
    if ((path === "/api/receive" || path === "/api/parse_and_save") && method === "POST") {
      let body = null;
      try {
        body = await request.json();
      } catch (err) {
        return jsonResponse({ status: "error", message: "请求体非有效 JSON" }, 400);
      }

      if (!checkAuth(request, env, body)) {
        return jsonResponse({ status: "error", message: "鉴权失败: 访问密钥错误或未提供" }, 401);
      }

      if (!env.DB) {
        return jsonResponse({ status: "error", message: "未检测到 Cloudflare D1 数据库绑定 [DB]，请检查 wrangler.toml 配置" }, 500);
      }

      const clientIp = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "客户端";
      let records = [];

      if (Array.isArray(body.records)) {
        records = body.records;
      } else if (body.record && typeof body.record === "object") {
        records = [body.record];
      } else {
        return jsonResponse({ status: "error", message: "未找到有效的 records 数组或 record 对象" }, 400);
      }

      if (records.length === 0) {
        return jsonResponse({ status: "ok", received_count: 0, saved_count: 0, duplicates_count: 0, saved_records: [] });
      }

      const nowTime = getBeijingTime();
      const insertStmt = env.DB.prepare(`
        INSERT OR IGNORE INTO records (
          id, fingerprint,
          customer, sender_name, sender_phone, sender_country, sender_postcode, sender_state, sender_city, sender_district, sender_address,
          name, phone, country, postcode, state, city,
          address1, address2, address3, extra_info, email,
          full_address_std, full_address_intl, lat, lng, lat_lng,
          addr_type, sub_addr_type,
          item_name_en, item_name_cn, item_quantity,
          client_ip, created_at, raw_text
        ) VALUES (
          ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?,
          ?, ?, ?,
          ?, ?, ?
        )
      `);

      const batchStmts = [];
      const preparedRecords = [];

      for (const r of records) {
        const name = cleanStr(r.name);
        const phone = cleanStr(r.phone);
        const postcode = cleanStr(r.postcode);
        const address1 = cleanStr(r.address1);

        const senderName = cleanStr(r.sender_name);
        const senderPhone = cleanStr(r.sender_phone);
        const senderPostcode = cleanStr(r.sender_postcode);
        const senderAddress = cleanStr(r.sender_address);
        
        // 防重复唯一指纹: 优先收件人4要素，其次寄件人4要素
        let fp = cleanStr(r.fingerprint);
        if (!fp) {
          if (name || address1) {
            fp = `${name}|${phone}|${postcode}|${address1}`;
          } else {
            fp = `${senderName}|${senderPhone}|${senderPostcode}|${senderAddress}`;
          }
        }

        const recordId = cleanStr(r.id) || (await sha256Hex(fp)).slice(0, 16);
        const createdAt = cleanStr(r.created_at) || nowTime;

        const prepared = {
          id: recordId,
          fingerprint: fp,

          // 寄件人
          customer: cleanStr(r.customer),
          sender_name: senderName,
          sender_phone: senderPhone,
          sender_country: cleanStr(r.sender_country) || "US",
          sender_postcode: senderPostcode,
          sender_state: cleanStr(r.sender_state),
          sender_city: cleanStr(r.sender_city),
          sender_district: cleanStr(r.sender_district),
          sender_address: senderAddress,

          // 收件人
          name: name,
          phone: phone,
          country: cleanStr(r.country) || "US",
          postcode: postcode,
          state: cleanStr(r.state),
          city: cleanStr(r.city),
          address1: address1,
          address2: cleanStr(r.address2),
          address3: cleanStr(r.address3),
          extra_info: cleanStr(r.extra_info),
          email: cleanStr(r.email),
          full_address_std: cleanStr(r.full_address_std || r.full_address),
          full_address_intl: cleanStr(r.full_address_intl),
          lat: cleanStr(r.lat),
          lng: cleanStr(r.lng),
          lat_lng: cleanStr(r.lat_lng),
          addr_type: cleanStr(r.addr_type),
          sub_addr_type: cleanStr(r.sub_addr_type),

          // 物品
          item_name_en: cleanStr(r.item_name_en),
          item_name_cn: cleanStr(r.item_name_cn),
          item_quantity: cleanStr(r.item_quantity),

          // 元数据
          client_ip: cleanStr(r.client_ip) || clientIp,
          created_at: createdAt,
          raw_text: cleanStr(r.raw_text)
        };

        preparedRecords.push(prepared);
        batchStmts.push(insertStmt.bind(
          prepared.id,
          prepared.fingerprint,

          prepared.customer,
          prepared.sender_name,
          prepared.sender_phone,
          prepared.sender_country,
          prepared.sender_postcode,
          prepared.sender_state,
          prepared.sender_city,
          prepared.sender_district,
          prepared.sender_address,

          prepared.name,
          prepared.phone,
          prepared.country,
          prepared.postcode,
          prepared.state,
          prepared.city,
          prepared.address1,
          prepared.address2,
          prepared.address3,
          prepared.extra_info,
          prepared.email,
          prepared.full_address_std,
          prepared.full_address_intl,
          prepared.lat,
          prepared.lng,
          prepared.lat_lng,
          prepared.addr_type,
          prepared.sub_addr_type,

          prepared.item_name_en,
          prepared.item_name_cn,
          prepared.item_quantity,

          prepared.client_ip,
          prepared.created_at,
          prepared.raw_text
        ));
      }

      try {
        const batchResults = await env.DB.batch(batchStmts);
        const savedRecords = [];
        let savedCount = 0;
        let dupCount = 0;

        for (let i = 0; i < batchResults.length; i++) {
          const res = batchResults[i];
          const rec = preparedRecords[i];
          if (res.meta && res.meta.changes > 0) {
            savedCount++;
            savedRecords.push(rec);
          } else {
            dupCount++;
          }
        }

        return jsonResponse({
          status: "ok",
          received_count: records.length,
          saved_count: savedCount,
          duplicates_count: dupCount,
          saved_records: savedRecords
        });
      } catch (dbErr) {
        return jsonResponse({
          status: "error",
          message: `D1 数据库写入异常: ${dbErr.message}`
        }, 500);
      }
    }

    // 5. 数据查询接口 (GET /api/records)
    if (path === "/api/records" && method === "GET") {
      if (!checkAuth(request, env)) {
        return jsonResponse({ status: "error", message: "未授权: 请提供正确的访问密钥" }, 401);
      }
      if (!env.DB) {
        return jsonResponse({ status: "error", message: "未绑定 D1 数据库" }, 500);
      }

      const q = (url.searchParams.get("q") || "").trim();
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10), 500);
      const page = Math.max(parseInt(url.searchParams.get("page") || "1", 10), 1);
      const offset = (page - 1) * limit;

      try {
        let recordsQuery;
        if (q) {
          const qLike = `%${q}%`;
          recordsQuery = env.DB.prepare(`
            SELECT * FROM records
            WHERE name LIKE ?1 OR phone LIKE ?1 OR city LIKE ?1 OR state LIKE ?1
               OR postcode LIKE ?1 OR address1 LIKE ?1 OR client_ip LIKE ?1
               OR sender_name LIKE ?1 OR sender_city LIKE ?1 OR customer LIKE ?1
               OR item_name_en LIKE ?1 OR sender_address LIKE ?1
            ORDER BY created_at DESC LIMIT ?2 OFFSET ?3
          `).bind(qLike, limit, offset);
        } else {
          recordsQuery = env.DB.prepare(`
            SELECT * FROM records ORDER BY created_at DESC LIMIT ?1 OFFSET ?2
          `).bind(limit, offset);
        }

        const [listRes, totalCountRes, todayCountRes, uniqueIpRes] = await env.DB.batch([
          recordsQuery,
          env.DB.prepare(`SELECT COUNT(*) as cnt FROM records`),
          env.DB.prepare(`SELECT COUNT(*) as cnt FROM records WHERE created_at >= date('now', '+8 hours')`),
          env.DB.prepare(`SELECT COUNT(DISTINCT client_ip) as cnt FROM records`)
        ]);

        const records = listRes.results || [];
        const totalRecords = totalCountRes.results?.[0]?.cnt || 0;
        const todayRecords = todayCountRes.results?.[0]?.cnt || 0;
        const uniqueIps = uniqueIpRes.results?.[0]?.cnt || 0;

        return jsonResponse({
          status: "ok",
          stats: {
            total_records: totalRecords,
            today_records: todayRecords,
            unique_ips: uniqueIps
          },
          pagination: {
            page,
            limit,
            returned: records.length
          },
          records
        });
      } catch (err) {
        return jsonResponse({ status: "error", message: `D1 查询异常: ${err.message}` }, 500);
      }
    }

    // 6. CSV 导出接口 (GET /api/export/csv)
    if ((path === "/api/export/csv" || path === "/api/download/csv") && method === "GET") {
      if (!checkAuth(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (!env.DB) {
        return new Response("Database not configured", { status: 500 });
      }

      try {
        const { results } = await env.DB.prepare(`SELECT * FROM records ORDER BY created_at DESC`).all();
        const records = results || [];

        const headers = [
          "ID", "客户",
          "寄件人姓名", "寄件人手机号", "寄件国家", "寄件地邮编", "寄件州/省", "寄件城市", "寄件区", "寄件地详细地址",
          "收件人姓名", "收件人手机号", "收件国家", "收件地邮编", "收件州/省", "收件市", "收件地址一", "收件地址二", "收件地址三",
          "附加信息", "收件人邮箱", "标准详细地址", "国际详细地址", "纬度", "经度", "原始经纬度", "地址类型", "二级地址类型",
          "物品英文名称", "物品中文名称", "物品件数",
          "来源客户端IP", "录入时间"
        ];

        const escapeCsv = (val) => {
          if (val === null || val === undefined) return '""';
          const str = String(val).replace(/"/g, '""');
          return `"${str}"`;
        };

        const rows = [headers.map(escapeCsv).join(",")];

        for (const r of records) {
          rows.push([
            r.id,
            r.customer,
            r.sender_name,
            r.sender_phone,
            r.sender_country,
            r.sender_postcode,
            r.sender_state,
            r.sender_city,
            r.sender_district,
            r.sender_address,
            r.name,
            r.phone,
            r.country,
            r.postcode,
            r.state,
            r.city,
            r.address1,
            r.address2,
            r.address3,
            r.extra_info,
            r.email,
            r.full_address_std,
            r.full_address_intl,
            r.lat,
            r.lng,
            r.lat_lng,
            r.addr_type,
            r.sub_addr_type,
            r.item_name_en,
            r.item_name_cn,
            r.item_quantity,
            r.client_ip,
            r.created_at
          ].map(escapeCsv).join(","));
        }

        const csvContent = "\uFEFF" + rows.join("\r\n");
        const dateStr = getBeijingTime().slice(0, 10).replace(/-/g, "");

        return new Response(csvContent, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="waybill_records_${dateStr}.csv"`,
            ...CORS_HEADERS
          }
        });
      } catch (err) {
        return new Response(`Export failed: ${err.message}`, { status: 500 });
      }
    }

    // 7. JSON 导出接口
    if ((path === "/api/export/json" || path === "/api/download/json") && method === "GET") {
      if (!checkAuth(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (!env.DB) {
        return new Response("Database not configured", { status: 500 });
      }

      try {
        const { results } = await env.DB.prepare(`SELECT * FROM records ORDER BY created_at DESC`).all();
        const dateStr = getBeijingTime().slice(0, 10).replace(/-/g, "");
        return new Response(JSON.stringify(results || [], null, 2), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="waybill_records_${dateStr}.json"`,
            ...CORS_HEADERS
          }
        });
      } catch (err) {
        return new Response(`Export JSON failed: ${err.message}`, { status: 500 });
      }
    }

    // 8. 单条删除接口
    if (path === "/api/delete" && method === "POST") {
      let body = {};
      try { body = await request.json(); } catch(e) {}
      if (!checkAuth(request, env, body)) {
        return jsonResponse({ status: "error", message: "未授权" }, 401);
      }
      const recordId = cleanStr(body.id);
      if (!recordId) {
        return jsonResponse({ status: "error", message: "缺少待删除记录 ID" }, 400);
      }

      try {
        const res = await env.DB.prepare(`DELETE FROM records WHERE id = ?`).bind(recordId).run();
        return jsonResponse({ status: "ok", message: "删除成功", changes: res.meta?.changes || 0 });
      } catch (err) {
        return jsonResponse({ status: "error", message: `删除失败: ${err.message}` }, 500);
      }
    }

    // 9. 清空所有记录
    if (path === "/api/clear" && method === "POST") {
      let body = {};
      try { body = await request.json(); } catch(e) {}
      if (!checkAuth(request, env, body)) {
        return jsonResponse({ status: "error", message: "未授权" }, 401);
      }
      if (body.confirm !== "CONFIRM_DELETE_ALL") {
        return jsonResponse({ status: "error", message: "安全校验失败，缺少确认标识" }, 400);
      }

      try {
        await env.DB.prepare(`DELETE FROM records`).run();
        return jsonResponse({ status: "ok", message: "已清空所有记录" });
      } catch (err) {
        return jsonResponse({ status: "error", message: `清空失败: ${err.message}` }, 500);
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};

// ==========================================
// 嵌入式 Web 控制台 HTML 生成器 (含三栏卡片展示)
// ==========================================

function renderDashboardHtml(passwordRequired, appTitle) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${appTitle} - Cloudflare Workers + D1</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>📦</text></svg>">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
  </style>
</head>
<body class="bg-slate-50 text-slate-800 min-h-screen flex flex-col antialiased">

  <!-- 顶部导航 -->
  <header class="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-sm">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
      <div class="flex items-center space-x-3">
        <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 via-indigo-500 to-amber-500 flex items-center justify-center text-white text-xl font-bold shadow-md shadow-indigo-100">
          ⚡
        </div>
        <div>
          <div class="flex items-center space-x-2">
            <h1 class="text-base font-bold text-slate-900">${appTitle}</h1>
            <span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-amber-50 text-amber-700 border border-amber-200">
              Cloudflare Serverless
            </span>
            <span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-indigo-50 text-indigo-700 border border-indigo-200">
              D1 数据库
            </span>
          </div>
          <p class="text-xs text-slate-500">寄件人 • 收件人 • 物品信息全自动化实时归档</p>
        </div>
      </div>

      <div class="flex items-center space-x-2">
        <button onclick="openConfigModal()" class="inline-flex items-center space-x-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 shadow-sm transition">
          <svg class="w-3.5 h-3.5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
          <span>推送向导</span>
        </button>

        <button onclick="downloadExport('csv')" class="inline-flex items-center space-x-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm transition">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
          <span>导出完整 CSV</span>
        </button>

        <button onclick="downloadExport('json')" class="inline-flex items-center space-x-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm transition">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
          <span>导出 JSON</span>
        </button>

        <button id="lockBtn" onclick="logout()" title="锁定或更换访问密码" class="p-2 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg>
        </button>
      </div>
    </div>
  </header>

  <!-- 主体区域 -->
  <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6 flex-1 w-full">

    <!-- KPI 统计卡片 -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
        <div>
          <div class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">已汇总运单总数</div>
          <div class="text-3xl font-bold text-indigo-600" id="statTotal">0</div>
        </div>
        <div class="w-10 h-10 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center text-xl">📊</div>
      </div>

      <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
        <div>
          <div class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">今日新增记录 (UTC+8)</div>
          <div class="text-3xl font-bold text-emerald-600" id="statToday">0</div>
        </div>
        <div class="w-10 h-10 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center text-xl">⚡</div>
      </div>

      <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
        <div>
          <div class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">来源客户端 IP 数</div>
          <div class="text-3xl font-bold text-amber-600" id="statIps">0</div>
        </div>
        <div class="w-10 h-10 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center text-xl">🌐</div>
      </div>

      <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
        <div>
          <div class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">接收端服务状态</div>
          <div class="text-sm font-bold text-emerald-600 flex items-center space-x-1.5 mt-1">
            <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
            <span>三要素防重监听中</span>
          </div>
          <div class="text-[11px] text-slate-400 mt-0.5">/api/receive</div>
        </div>
        <div class="w-10 h-10 rounded-lg bg-slate-50 text-slate-500 flex items-center justify-center text-xl">🛡️</div>
      </div>
    </div>

    <!-- 列表控制栏 -->
    <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div class="p-4 border-b border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center space-x-3">
          <h2 class="text-sm font-bold text-slate-800">实时运单流</h2>
          <span id="badgeCount" class="text-xs bg-indigo-100 text-indigo-800 px-2 py-0.5 rounded-full font-medium">0 条</span>
          <label class="flex items-center space-x-1.5 text-xs text-slate-500 cursor-pointer select-none">
            <input type="checkbox" id="autoRefresh" checked class="rounded text-indigo-600 focus:ring-indigo-500">
            <span>实时轮询</span>
          </label>
        </div>

        <div class="flex items-center space-x-2">
          <div class="w-64 sm:w-80">
            <input type="text" id="searchInput" placeholder="搜索寄件人、收件人、品名、城市、客户..." class="w-full text-xs px-3 py-2 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500">
          </div>
          <button onclick="fetchData()" class="p-2 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition" title="手动刷新">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
          </button>
        </div>
      </div>

      <!-- 数据表格 -->
      <div class="overflow-x-auto">
        <table class="min-w-full divide-y divide-slate-200 text-left text-xs">
          <thead class="bg-slate-50 text-slate-500 font-semibold uppercase tracking-wider">
            <tr>
              <th class="px-4 py-3">录入时间</th>
              <th class="px-3 py-3">客户</th>
              <th class="px-4 py-3">寄件人姓名</th>
              <th class="px-4 py-3">寄件城市/地址</th>
              <th class="px-4 py-3">收件人</th>
              <th class="px-4 py-3">收件手机号</th>
              <th class="px-4 py-3">收件城市/邮编</th>
              <th class="px-4 py-3">街道详细地址</th>
              <th class="px-4 py-3">物品英文名称 (件数)</th>
              <th class="px-4 py-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody id="tableBody" class="divide-y divide-slate-100 bg-white">
            <tr>
              <td colspan="10" class="px-4 py-12 text-center text-slate-400">
                <div class="inline-block animate-spin w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full mb-2"></div>
                <div>正在连接 Cloudflare D1 边缘数据库...</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </main>

  <!-- 详情弹窗 (三模块分栏展示) -->
  <div id="detailModal" class="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 hidden flex items-center justify-center p-4">
    <div class="bg-white rounded-2xl max-w-3xl w-full shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]">
      <div class="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
        <div class="flex items-center space-x-2">
          <span class="text-base">📦</span>
          <h3 class="text-sm font-bold text-slate-900">运单综合详情卡片</h3>
        </div>
        <button onclick="closeDetailModal()" class="text-slate-400 hover:text-slate-600 text-lg leading-none">&times;</button>
      </div>

      <div class="p-6 overflow-y-auto space-y-5 text-xs" id="detailContent">
        <!-- 动态填充 -->
      </div>

      <div class="px-6 py-3 border-t border-slate-100 bg-slate-50 flex items-center justify-between">
        <div class="space-x-2">
          <button id="copyStdBtn" onclick="copyModalAddress()" class="px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium transition">
            复制完整收件地址
          </button>
          <button id="copySenderBtn" onclick="copySenderAddress()" class="px-3 py-1.5 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 font-medium transition">
            复制寄件地址
          </button>
        </div>
        <button onclick="closeDetailModal()" class="px-3 py-1.5 bg-white border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition">
          关闭
        </button>
      </div>
    </div>
  </div>

  <!-- 客户端配置向导弹窗 -->
  <div id="configModal" class="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 hidden flex items-center justify-center p-4">
    <div class="bg-white rounded-2xl max-w-xl w-full shadow-2xl border border-slate-200 overflow-hidden flex flex-col">
      <div class="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-indigo-50/50">
        <div class="flex items-center space-x-2">
          <span class="text-lg">🛠️</span>
          <h3 class="text-sm font-bold text-slate-900">客户端一键推送配置向导</h3>
        </div>
        <button onclick="closeConfigModal()" class="text-slate-400 hover:text-slate-600 text-lg leading-none">&times;</button>
      </div>

      <div class="p-6 space-y-4 text-xs">
        <div>
          <label class="block font-semibold text-slate-700 mb-1">当前 Worker 外部公网接收接口 (POST Webhook)</label>
          <div class="flex items-center space-x-2">
            <input type="text" id="webhookUrlDisplay" readonly class="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-700 font-mono text-[11px]">
            <button onclick="copyToClipboard(document.getElementById('webhookUrlDisplay').value, this)" class="px-3 py-2 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-medium rounded-lg transition whitespace-nowrap">
              复制 URL
            </button>
          </div>
        </div>

        <div>
          <label class="block font-semibold text-slate-700 mb-1">Windows/Mac 客户端 config.json 推荐配置</label>
          <pre class="bg-slate-900 text-slate-100 p-3 rounded-lg font-mono text-[11px] overflow-x-auto" id="configJsonCode"></pre>
        </div>

        <div>
          <label class="block font-semibold text-slate-700 mb-1">油猴脚本 Tampermonkey 顶部配置</label>
          <pre class="bg-slate-900 text-slate-100 p-3 rounded-lg font-mono text-[11px] overflow-x-auto" id="tampermonkeyCode"></pre>
        </div>
      </div>

      <div class="px-6 py-3 border-t border-slate-100 bg-slate-50 flex justify-end">
        <button onclick="closeConfigModal()" class="px-4 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition font-medium">
          我知道了
        </button>
      </div>
    </div>
  </div>

  <!-- 访问密码弹窗 -->
  <div id="authModal" class="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-50 hidden flex items-center justify-center p-4">
    <div class="bg-white rounded-2xl max-w-sm w-full shadow-2xl border border-slate-200 p-6 space-y-4">
      <div class="text-center space-y-1">
        <div class="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto text-2xl font-bold">
          🔒
        </div>
        <h3 class="text-base font-bold text-slate-900">需要访问密码</h3>
        <p class="text-xs text-slate-500">当前归档中心已启用密钥保护，请输入访问密码：</p>
      </div>

      <div>
        <input type="password" id="authPasswordInput" placeholder="请输入 ADMIN_PASSWORD" class="w-full text-xs px-3 py-2.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500" onkeydown="if(event.key==='Enter') submitAuth()">
        <p id="authErrorMsg" class="text-rose-500 text-[11px] mt-1.5 hidden"></p>
      </div>

      <button onclick="submitAuth()" class="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg text-xs transition shadow-sm">
        立即解锁大屏
      </button>
    </div>
  </div>

  <script>
    const PASSWORD_REQUIRED = ${passwordRequired ? "true" : "false"};
    let authToken = localStorage.getItem("REMOTE_AUTH_TOKEN") || "";
    let allRecords = [];
    let currentDetailRecord = null;
    let refreshTimer = null;

    const urlParams = new URLSearchParams(window.location.search);
    const tokenInUrl = urlParams.get("token") || urlParams.get("pwd") || urlParams.get("auth_token");
    if (tokenInUrl) {
      authToken = tokenInUrl.trim();
      localStorage.setItem("REMOTE_AUTH_TOKEN", authToken);
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    function getAuthHeaders() {
      const headers = { "Content-Type": "application/json" };
      if (authToken) {
        headers["Authorization"] = "Bearer " + authToken;
        headers["x-auth-token"] = authToken;
      }
      return headers;
    }

    async function checkAuthAndInit() {
      if (PASSWORD_REQUIRED && !authToken) {
        openAuthModal();
        return;
      }
      await fetchData();
      setupAutoRefresh();
    }

    async function fetchData() {
      const q = (document.getElementById("searchInput")?.value || "").trim();
      let url = "/api/records?limit=300";
      if (q) url += "&q=" + encodeURIComponent(q);

      try {
        const res = await fetch(url, { headers: getAuthHeaders() });
        if (res.status === 401) {
          openAuthModal("访问密码已失效或错误，请重新输入");
          return;
        }

        const data = await res.json();
        if (data.status === "ok") {
          allRecords = data.records || [];
          const stats = data.stats || {};
          document.getElementById("statTotal").innerText = stats.total_records || allRecords.length;
          document.getElementById("statToday").innerText = stats.today_records || 0;
          document.getElementById("statIps").innerText = stats.unique_ips || 0;
          document.getElementById("badgeCount").innerText = allRecords.length + " 条";
          renderTable();
        }
      } catch (err) {
        console.error("拉取数据失败:", err);
      }
    }

    function renderTable() {
      const tbody = document.getElementById("tableBody");
      const search = (document.getElementById("searchInput").value || "").trim().toLowerCase();

      let filtered = allRecords;
      if (search) {
        filtered = allRecords.filter(r => {
          const str = [
            r.sender_name, r.sender_phone, r.sender_city, r.sender_address, r.customer,
            r.name, r.phone, r.city, r.state, r.postcode, r.address1,
            r.item_name_en, r.client_ip
          ].join(" ").toLowerCase();
          return str.includes(search);
        });
      }

      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" class="px-4 py-12 text-center text-slate-400">暂无匹配的数据记录</td></tr>';
        return;
      }

      tbody.innerHTML = filtered.map(r => \`
        <tr class="hover:bg-slate-50 transition-colors">
          <td class="px-4 py-3 whitespace-nowrap text-slate-500 font-mono text-[11px]">\${r.created_at || '-'}</td>
          <td class="px-3 py-3 whitespace-nowrap"><span class="px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 font-bold text-[11px]">\${escapeHtml(r.customer || '-')}</span></td>
          <td class="px-4 py-3 whitespace-nowrap font-medium text-slate-800" title="\${escapeHtml(r.sender_name)}">\${escapeHtml(r.sender_name || '-')}</td>
          <td class="px-4 py-3 text-slate-600 max-w-[140px] truncate" title="\${escapeHtml((r.sender_city ? r.sender_city + ' ' : '') + (r.sender_address || ''))}">\${escapeHtml(r.sender_city || '')} \${escapeHtml(r.sender_address || '-')}</td>
          <td class="px-4 py-3 whitespace-nowrap font-semibold text-slate-900">\${escapeHtml(r.name || '-')}</td>
          <td class="px-4 py-3 whitespace-nowrap font-mono text-slate-700">
            <span class="cursor-pointer hover:text-indigo-600" onclick="copyToClipboard('\${r.phone}', this)" title="点击复制收件电话">\${escapeHtml(r.phone || '-')}</span>
          </td>
          <td class="px-4 py-3 whitespace-nowrap text-slate-700">\${escapeHtml(r.city || '')} \${r.state ? '(' + escapeHtml(r.state) + ')' : ''} <span class="font-mono text-slate-500">\${escapeHtml(r.postcode || '')}</span></td>
          <td class="px-4 py-3 text-slate-600 max-w-[160px] truncate" title="\${escapeHtml(r.address1 || '')}">\${escapeHtml(r.address1 || '-')}</td>
          <td class="px-4 py-3 whitespace-nowrap text-slate-700">
            <span class="font-medium text-indigo-700">\${escapeHtml(r.item_name_en || '-')}</span>
            \${r.item_quantity ? '<span class="ml-1 px-1.5 py-0.2 rounded bg-amber-100 text-amber-800 text-[10px] font-bold">x' + escapeHtml(r.item_quantity) + '</span>' : ''}
          </td>
          <td class="px-4 py-3 whitespace-nowrap text-right space-x-2">
            <button onclick="viewDetail('\${r.id}')" class="text-indigo-600 hover:text-indigo-800 font-medium">详情</button>
            <button onclick="deleteRecord('\${r.id}')" class="text-rose-500 hover:text-rose-700">删除</button>
          </td>
        </tr>
      \`).join("");
    }

    function viewDetail(id) {
      const record = allRecords.find(r => r.id === id);
      if (!record) return;
      currentDetailRecord = record;

      const fullAddr = record.full_address_std || [record.name, record.phone, record.address1, record.address2, record.city, record.state, record.postcode, record.country].filter(Boolean).join(", ");
      const senderAddr = [record.sender_address, record.sender_city, record.sender_state, record.sender_postcode, record.sender_country].filter(Boolean).join(", ");

      const html = \`
        <!-- 1. 寄件人信息板块 -->
        <div class="border border-purple-200 bg-purple-50/30 rounded-xl p-4 space-y-3">
          <div class="flex items-center justify-between border-b border-purple-100 pb-2">
            <div class="flex items-center space-x-1.5">
              <span class="text-base">📤</span>
              <span class="font-bold text-purple-900 text-xs uppercase tracking-wide">寄件人信息 (Sender)</span>
            </div>
            \${record.customer ? '<span class="px-2 py-0.5 rounded bg-purple-100 text-purple-800 font-bold text-[11px]">客户: ' + escapeHtml(record.customer) + '</span>' : ''}
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div><span class="text-slate-400">寄件人姓名：</span><span class="font-bold text-slate-800">\${escapeHtml(record.sender_name || '-')}</span></div>
            <div><span class="text-slate-400">寄件手机号：</span><span class="font-mono text-slate-800">\${escapeHtml(record.sender_phone || '-')}</span></div>
            <div><span class="text-slate-400">寄件国家：</span><span class="font-semibold text-slate-800">\${escapeHtml(record.sender_country || 'US')}</span></div>
            <div><span class="text-slate-400">寄件州/省：</span><span class="text-slate-800">\${escapeHtml(record.sender_state || '-')}</span></div>
            <div><span class="text-slate-400">寄件城市：</span><span class="text-slate-800">\${escapeHtml(record.sender_city || '-')}</span></div>
            <div><span class="text-slate-400">寄件邮编：</span><span class="font-mono text-slate-800">\${escapeHtml(record.sender_postcode || '-')}</span></div>
            \${record.sender_district ? '<div><span class="text-slate-400">寄件区：</span><span class="text-slate-800">' + escapeHtml(record.sender_district) + '</span></div>' : ''}
          </div>

          <div>
            <span class="text-slate-400 block mb-1">寄件地详细地址：</span>
            <div class="p-2 bg-white rounded border border-purple-100 font-mono text-slate-800 select-all">\${escapeHtml(record.sender_address || '-')}</div>
          </div>
        </div>

        <!-- 2. 收件人信息板块 -->
        <div class="border border-indigo-200 bg-indigo-50/30 rounded-xl p-4 space-y-3">
          <div class="flex items-center space-x-1.5 border-b border-indigo-100 pb-2">
            <span class="text-base">📥</span>
            <span class="font-bold text-indigo-900 text-xs uppercase tracking-wide">收件人信息 (Recipient)</span>
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div><span class="text-slate-400">收件人姓名：</span><span class="font-bold text-slate-900">\${escapeHtml(record.name || '-')}</span></div>
            <div><span class="text-slate-400">收件手机号：</span><span class="font-mono font-bold text-slate-900">\${escapeHtml(record.phone || '-')}</span></div>
            <div><span class="text-slate-400">收件国家：</span><span class="font-semibold text-blue-700">\${escapeHtml(record.country || 'US')}</span></div>
            <div><span class="text-slate-400">收件州/省：</span><span class="text-slate-900">\${escapeHtml(record.state || '-')}</span></div>
            <div><span class="text-slate-400">收件城市：</span><span class="text-slate-900">\${escapeHtml(record.city || '-')}</span></div>
            <div><span class="text-slate-400">收件邮编：</span><span class="font-mono text-slate-900 font-bold">\${escapeHtml(record.postcode || '-')}</span></div>
            \${record.email ? '<div><span class="text-slate-400">邮箱：</span><span class="font-mono text-slate-800">' + escapeHtml(record.email) + '</span></div>' : ''}
            \${record.addr_type ? '<div><span class="text-slate-400">地址类型：</span><span class="text-slate-800">' + escapeHtml(record.addr_type) + '</span></div>' : ''}
          </div>

          <div>
            <span class="text-slate-400 block mb-1">收件街道地址一：</span>
            <div class="p-2 bg-white rounded border border-indigo-100 font-mono text-slate-900 select-all font-medium">\${escapeHtml(record.address1 || '-')}</div>
          </div>

          \${record.address2 ? \`
          <div>
            <span class="text-slate-400 block mb-1">收件地址二 (公寓/单元/Suite)：</span>
            <div class="p-2 bg-white rounded border border-indigo-100 font-mono text-slate-900 select-all">\${escapeHtml(record.address2)}</div>
          </div>\` : ''}

          <div>
            <span class="text-slate-400 block mb-1">组合标准地址：</span>
            <div class="p-2 bg-indigo-100/40 rounded border border-indigo-200 font-mono text-indigo-900 select-all font-semibold">\${escapeHtml(fullAddr)}</div>
          </div>
        </div>

        <!-- 3. 物品信息板块 -->
        <div class="border border-amber-200 bg-amber-50/30 rounded-xl p-4 space-y-3">
          <div class="flex items-center space-x-1.5 border-b border-amber-100 pb-2">
            <span class="text-base">🏷️</span>
            <span class="font-bold text-amber-900 text-xs uppercase tracking-wide">物品信息 (Cargo / Item)</span>
          </div>

          <div class="grid grid-cols-3 gap-3">
            <div class="col-span-2">
              <span class="text-slate-400 block mb-1">物品英文名称：</span>
              <div class="p-2 bg-white rounded border border-amber-100 font-bold text-slate-900 select-all font-mono">\${escapeHtml(record.item_name_en || '-')}</div>
            </div>
            <div>
              <span class="text-slate-400 block mb-1">件数：</span>
              <div class="p-2 bg-white rounded border border-amber-100 font-bold text-amber-700 text-center font-mono text-sm">\${escapeHtml(record.item_quantity || '1')}</div>
            </div>
            \${record.item_name_cn ? '<div class="col-span-3"><span class="text-slate-400 block mb-1">物品中文名称：</span><div class="p-2 bg-white rounded border border-amber-100 text-slate-800">' + escapeHtml(record.item_name_cn) + '</div></div>' : ''}
          </div>
        </div>

        <!-- 4. 元数据 -->
        <div class="grid grid-cols-2 gap-3 text-slate-500 pt-2 border-t border-slate-100 text-[11px]">
          <div>来源 IP: <span class="font-mono">\${escapeHtml(record.client_ip || '-')}</span></div>
          <div>录入时间: <span class="font-mono">\${escapeHtml(record.created_at || '-')}</span></div>
          <div class="col-span-2">防重指纹: <span class="font-mono truncate block" title="\${escapeHtml(record.fingerprint)}">\${escapeHtml(record.fingerprint || '-')}</span></div>
        </div>
      \`;

      document.getElementById("detailContent").innerHTML = html;
      document.getElementById("detailModal").classList.remove("hidden");
    }

    function closeDetailModal() {
      document.getElementById("detailModal").classList.add("hidden");
      currentDetailRecord = null;
    }

    function copyModalAddress() {
      if (!currentDetailRecord) return;
      const r = currentDetailRecord;
      const addr = r.full_address_std || [r.name, r.phone, r.address1, r.address2, r.city, r.state, r.postcode, r.country].filter(Boolean).join(", ");
      copyToClipboard(addr, document.getElementById("copyStdBtn"), "已复制收件地址!");
    }

    function copySenderAddress() {
      if (!currentDetailRecord) return;
      const r = currentDetailRecord;
      const addr = [r.sender_name, r.sender_phone, r.sender_address, r.sender_city, r.sender_state, r.sender_postcode, r.sender_country].filter(Boolean).join(", ");
      copyToClipboard(addr, document.getElementById("copySenderBtn"), "已复制寄件地址!");
    }

    async function deleteRecord(id) {
      if (!confirm("确定要删除这条运单记录吗？")) return;
      try {
        const res = await fetch("/api/delete", {
          method: "POST",
          headers: getAuthHeaders(),
          body: JSON.stringify({ id })
        });
        const data = await res.json();
        if (data.status === "ok") {
          allRecords = allRecords.filter(r => r.id !== id);
          renderTable();
        } else {
          alert("删除失败: " + data.message);
        }
      } catch (err) {
        alert("网络异常: " + err.message);
      }
    }

    function downloadExport(type) {
      let url = type === "csv" ? "/api/export/csv" : "/api/export/json";
      if (authToken) {
        url += "?token=" + encodeURIComponent(authToken);
      }
      window.open(url, "_blank");
    }

    function openConfigModal() {
      const fullOrigin = window.location.origin;
      const webhookUrl = fullOrigin + "/api/receive";
      document.getElementById("webhookUrlDisplay").value = webhookUrl;

      const cfgJson = {
        server_url: webhookUrl,
        auth_token: authToken || "YOUR_PASSWORD_HERE",
        poll_interval_seconds: 1.5,
        enable_chrome_cdp_monitor: true,
        enable_clipboard_monitor: true
      };
      document.getElementById("configJsonCode").innerText = JSON.stringify(cfgJson, null, 2);

      const tamperScript = \`// 【修改项】直接推送到您的 Cloudflare Worker
const SERVER_URL = "\${webhookUrl}";
const AUTH_TOKEN = "\${authToken || ''}";\`;
      document.getElementById("tampermonkeyCode").innerText = tamperScript;

      document.getElementById("configModal").classList.remove("hidden");
    }

    function closeConfigModal() {
      document.getElementById("configModal").classList.add("hidden");
    }

    function openAuthModal(msg) {
      const errEl = document.getElementById("authErrorMsg");
      if (msg) {
        errEl.innerText = msg;
        errEl.classList.remove("hidden");
      } else {
        errEl.classList.add("hidden");
      }
      document.getElementById("authPasswordInput").value = "";
      document.getElementById("authModal").classList.remove("hidden");
      setTimeout(() => document.getElementById("authPasswordInput").focus(), 100);
    }

    async function submitAuth() {
      const pwd = document.getElementById("authPasswordInput").value.trim();
      if (!pwd) return;

      try {
        const res = await fetch("/api/auth/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: pwd })
        });
        const data = await res.json();
        if (data.status === "ok") {
          authToken = pwd;
          localStorage.setItem("REMOTE_AUTH_TOKEN", authToken);
          document.getElementById("authModal").classList.add("hidden");
          fetchData();
          setupAutoRefresh();
        } else {
          openAuthModal("密码错误，请核对后再试");
        }
      } catch (e) {
        openAuthModal("验证请求失败，请检查网络");
      }
    }

    function logout() {
      if (confirm("是否清除本地保存的访问密码？")) {
        localStorage.removeItem("REMOTE_AUTH_TOKEN");
        authToken = "";
        location.reload();
      }
    }

    function setupAutoRefresh() {
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(() => {
        const checked = document.getElementById("autoRefresh")?.checked;
        if (checked && !document.hidden) {
          fetchData();
        }
      }, 3000);
    }

    function copyToClipboard(text, btnElement, successText = "已复制!") {
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        if (btnElement) {
          const orig = btnElement.innerText;
          btnElement.innerText = successText;
          setTimeout(() => btnElement.innerText = orig, 1500);
        }
      });
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    window.addEventListener("DOMContentLoaded", () => {
      checkAuthAndInit();
      document.getElementById("searchInput")?.addEventListener("input", renderTable);
    });
  </script>
</body>
</html>`;
}
