-- =======================================================
-- Cloudflare D1 数据库初始化表结构
-- 支持完整的【寄件人信息】+【收件人信息】+【物品信息】持久化与去重存储
-- =======================================================

CREATE TABLE IF NOT EXISTS records (
    id TEXT PRIMARY KEY,                       -- 唯一记录ID (如 MD5 截取或 UUID)
    fingerprint TEXT UNIQUE,                   -- 防重复唯一指纹: name|phone|postcode|address1

    -- 1. 寄件人信息
    customer TEXT DEFAULT '',                  -- 客户 (如 YG)
    sender_name TEXT DEFAULT '',               -- 寄件人姓名 (如 Dept.CA # 11WG15536)
    sender_phone TEXT DEFAULT '',              -- 寄件人手机号
    sender_country TEXT DEFAULT 'US',          -- 寄件国家 (如 US)
    sender_postcode TEXT DEFAULT '',           -- 寄件地邮编 (如 91762)
    sender_state TEXT DEFAULT '',              -- 寄件州/省 (如 CA)
    sender_city TEXT DEFAULT '',               -- 寄件城市 (如 Ontario)
    sender_district TEXT DEFAULT '',           -- 寄件区
    sender_address TEXT DEFAULT '',            -- 寄件地详细地址 (如 2221 E. Remington Ave)

    -- 2. 收件人信息
    name TEXT DEFAULT '',                      -- 收件人姓名
    phone TEXT DEFAULT '',                     -- 收件人手机号
    country TEXT DEFAULT 'US',                 -- 收件国家
    postcode TEXT DEFAULT '',                  -- 收件地邮编
    state TEXT DEFAULT '',                     -- 收件州/省
    city TEXT DEFAULT '',                      -- 收件城市
    address1 TEXT DEFAULT '',                  -- 收件详细地址一 (门牌+街道)
    address2 TEXT DEFAULT '',                  -- 收件详细地址二 (公寓/单元/Suite)
    address3 TEXT DEFAULT '',                  -- 收件详细地址三
    extra_info TEXT DEFAULT '',                -- 附加信息 / 门禁备注等
    email TEXT DEFAULT '',                     -- 收件人邮箱
    full_address_std TEXT DEFAULT '',          -- 标准拼接详细地址
    full_address_intl TEXT DEFAULT '',         -- 国际格式详细地址
    lat TEXT DEFAULT '',                       -- 纬度
    lng TEXT DEFAULT '',                       -- 经度
    lat_lng TEXT DEFAULT '',                   -- 经纬度合并
    addr_type TEXT DEFAULT '',                 -- 地址类型 (residential / commercial)
    sub_addr_type TEXT DEFAULT '',             -- 二级地址类型 (single_family / multi_family 等)

    -- 3. 物品信息
    item_name_en TEXT DEFAULT '',              -- 物品英文名称 (如 WOODEN PET HUTCHES)
    item_name_cn TEXT DEFAULT '',              -- 物品中文名称
    item_quantity TEXT DEFAULT '',             -- 物品件数 (如 1)

    -- 4. 系统元数据
    client_ip TEXT DEFAULT '',                 -- 上报来源客户端 IP
    created_at TEXT DEFAULT '',                -- 录入时间 (YYYY-MM-DD HH:MM:SS)
    raw_text TEXT DEFAULT ''                   -- 原始未解析文本/网页片段
);

-- 常用查询索引
CREATE INDEX IF NOT EXISTS idx_records_created_at ON records(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_records_fingerprint ON records(fingerprint);
CREATE INDEX IF NOT EXISTS idx_records_phone ON records(phone);
CREATE INDEX IF NOT EXISTS idx_records_name ON records(name);
CREATE INDEX IF NOT EXISTS idx_records_sender_name ON records(sender_name);
CREATE INDEX IF NOT EXISTS idx_records_customer ON records(customer);
