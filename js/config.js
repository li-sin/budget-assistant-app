const CONFIG = {
  APP_VERSION: '3.23.2',
  CLIENT_ID: '320535010458-j5ud52freto8277f0qp0lr4919b86br4.apps.googleusercontent.com',
  SHEET_ID: '1T2G8leVwJ8EES1GzEcL1bD_NLHe46ylmPPijc-VoKmo',
  SCOPES: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly',
  INVOICE_PROXY_URL: 'https://invoice-proxy.lovelisa00000.workers.dev/',
  EMAIL_WHITELIST: [
    'lovelisa00000@gmail.com',
    'z1237277@gmail.com',
    'ashleyzhanya@gmail.com',
  ],
  TABS: {
    MONTHLY:    '月度帳本',
    SETTLEMENT: 'Bear結算',
    CC:         '信用卡明細',
    INVOICE:    '發票明細',
    ITEMS:      '品項明細',
    RULES:      '商店分類規則',
    MANUAL_LINK: '手記配對',  // 先記的手動帳 ↔ 之後到的發票／信用卡：A 類型(inv/cc) B 鍵 C 決定(same/not/reverted) D 手記鍵 E 建立時間
    CUSTODY:    '代管款',   // 家人放在 Sin 這邊的錢（媽媽禮金）：存入正數、用掉負數，加總＝餘額
  },
  SETTLEMENT_CELL: 'D3',  // 淨額 = B3(Bear欠Sin) - C3(Sin欠Bear)
  MONTHLY_SHEET_ID: 1410303165,   // 月度帳本工作表的數字 ID（從 Sheets URL #gid= 取得）
  INVOICE_SHEET_ID: 1016861424,   // 發票明細
  ITEMS_SHEET_ID:   3922285,      // 品項明細
  DEFAULT_NOTE_CHIPS: ['UberEats', '蝦皮'],
  // App 建立的發票備註含以下關鍵字時，視為信用卡付款平台，自動比對信用卡明細
  CC_PAY_KEYWORDS: ['ubereats', '蝦皮'],
  // 信用卡待填的常吃品項：刷卡店名含 match 任一字串就帶入（比對時不分全半形、大小寫，忽略空白）；價格變動改這裡
  // who：'Sin'／'Bear'＝算那個人；'half'＝兩人平分；'larger'＝算目前金額比較多的人（一樣多算 Sin）
  // group：同組只能選一個；scaleOf：打折（同組已選那項的價格 × factor，算給同一個人）
  // requires：店名還要含這些字才套用（Uber Eats 版放前面）；fees:'half'＝刷卡扣掉品項後的外送費、服務費兩人平分
  SHOP_PRESETS: [
    {
      match: ['ounuo', 'onopoke', 'onepoke'], requires: ['優步'], name: 'One Poké（Uber Eats）', category: '🍴', fees: 'half',
      items:  [{ who: 'Sin', icon: '🍣', name: '鮭魚', price: 240 }, { who: 'Bear', icon: '🐟', name: '鮪魚', price: 215 }],
      addons: [
        // Uber Eats 的味噌湯固定買一送一、兩碗共 45（2026-11-08 Sin）：只有 Bear 喝算 Bear，兩人都喝就平分
        { icon: '🍲', name: '味噌湯 Bear 喝', price: 45, who: 'Bear', group: 'soup' },
        { icon: '🍲', name: '味噌湯兩人都喝', price: 45, who: 'half', group: 'soup' },
      ],
    },
    {
      match: ['ounuo', 'onopoke', 'onepoke'], name: 'One Poké', category: '🍴',
      items:  [{ who: 'Sin', icon: '🍣', name: '鮭魚', price: 175 }, { who: 'Bear', icon: '🐟', name: '鮪魚', price: 155 }],
      addons: [{ icon: '🧈', name: '有加豆腐', price: 25, who: 'Sin' }, { icon: '🍲', name: '加味噌湯', price: 30, who: 'Bear' }, { icon: '🛍️', name: '有買袋子', price: 1, who: 'larger' }],
    },
  ],
};
