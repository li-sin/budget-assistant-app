const CONFIG = {
  APP_VERSION: '3.7.11',
  CLIENT_ID: '320535010458-j5ud52freto8277f0qp0lr4919b86br4.apps.googleusercontent.com',
  SHEET_ID: '1T2G8leVwJ8EES1GzEcL1bD_NLHe46ylmPPijc-VoKmo',
  SCOPES: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email',
  INVOICE_PROXY_URL: 'https://invoice-proxy.lovelisa00000.workers.dev/',
  EMAIL_WHITELIST: [
    'lovelisa00000@gmail.com',
    'z1237277@gmail.com',
  ],
  TABS: {
    MONTHLY:    '月度帳本',
    SETTLEMENT: 'Bear結算',
    CC:         '信用卡明細',
    INVOICE:    '發票明細',
    ITEMS:      '品項明細',
    RULES:      '商店分類規則',
  },
  SETTLEMENT_CELL: 'D3',  // 淨額 = B3(Bear欠Sin) - C3(Sin欠Bear)
  MONTHLY_SHEET_ID: 1410303165,   // 月度帳本工作表的數字 ID（從 Sheets URL #gid= 取得）
  INVOICE_SHEET_ID: 1016861424,   // 發票明細
  ITEMS_SHEET_ID:   3922285,      // 品項明細
  DEFAULT_NOTE_CHIPS: ['UberEats', '蝦皮'],
  // 掃描發票備註含以下關鍵字時，視為信用卡付款平台，自動比對信用卡明細
  CC_PAY_KEYWORDS: ['ubereats', '蝦皮'],
};
