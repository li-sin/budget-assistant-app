const CONFIG = {
  CLIENT_ID: '320535010458-j5ud52freto8277f0qp0lr4919b86br4.apps.googleusercontent.com',
  SHEET_ID: '1T2G8leVwJ8EES1GzEcL1bD_NLHe46ylmPPijc-VoKmo',
  SCOPES: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email',
  INVOICE_PROXY_URL: '',  // Cloudflare Worker URL（Phase 3 補入）
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
  },
  SETTLEMENT_CELL: 'D3',  // 淨額 = B3(Bear欠Sin) - C3(Sin欠Bear)
  MONTHLY_SHEET_ID: 0,   // 月度帳本工作表的數字 ID（從 Sheets URL #gid= 取得）
};
