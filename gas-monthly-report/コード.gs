/**
 * 松井塗装 月次サイト反応レポート
 * ・毎月15日と末日の朝に、お問い合わせ状況とGA4クリック数を集計してメール送信する
 * ・お問い合わせフォーム用の既存GASとは完全に別プロジェクトとして運用すること
 */

// ==== 設定 ====
var CONTACT_SPREADSHEET_ID = '1gxT-1HCr6UPY2rXgIEqls5EEvW0MdQxfzASUgekuhUM';
var CONTACT_SHEET_NAME = 'シート1';
var GA4_PROPERTY_ID = 'properties/544263595';
var MAIL_TO = 'nreo0525@gmail.com,matsui.painter@gmail.com';

/**
 * トリガーから毎日呼び出す想定のエントリーポイント。
 * 今日が15日または月末でなければ何もしない。
 */
function main() {
  var period = getReportPeriod_();
  if (!period) {
    Logger.log('本日はレポート対象日ではありません。');
    return;
  }
  runReport_(period);
}

/**
 * 動作確認用。今日の日付にかかわらず「今月1日〜今日」を集計してテストメールを送る。
 * 前回集計値の上書きは行わない（本番のトリガー実行に影響を与えないため）。
 */
function testRun() {
  var today = new Date();
  var period = {
    start: new Date(today.getFullYear(), today.getMonth(), 1, 0, 0, 0),
    end: today,
    monthLabel: (today.getMonth() + 1) + '月（テスト実行）'
  };
  var contactStats = collectContactStats_(period.start, period.end);
  var gaStats = collectGA4Stats_(period.start, period.end);
  var prev = getPreviousStats_();
  sendReportEmail_(period, contactStats, gaStats, prev);
  Logger.log('テストメールを送信しました。');
}

// ==== 期間の判定 ====
function getReportPeriod_() {
  var today = new Date();
  var year = today.getFullYear();
  var month = today.getMonth(); // 0-11
  var day = today.getDate();
  var lastDayOfMonth = new Date(year, month + 1, 0).getDate();

  if (day === 15) {
    return {
      start: new Date(year, month, 1, 0, 0, 0),
      end: new Date(year, month, 15, 23, 59, 59),
      monthLabel: (month + 1) + '月前半'
    };
  }
  if (day === lastDayOfMonth) {
    return {
      start: new Date(year, month, 16, 0, 0, 0),
      end: new Date(year, month, lastDayOfMonth, 23, 59, 59),
      monthLabel: (month + 1) + '月後半'
    };
  }
  return null;
}

// ==== 本体処理 ====
function runReport_(period) {
  var contactStats = collectContactStats_(period.start, period.end);
  var gaStats = collectGA4Stats_(period.start, period.end);
  var prev = getPreviousStats_();
  sendReportEmail_(period, contactStats, gaStats, prev);
  savePreviousStats_(contactStats, gaStats);
}

// ==== お問い合わせスプレッドシートの集計 ====
function collectContactStats_(start, end) {
  var ss = SpreadsheetApp.openById(CONTACT_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(CONTACT_SHEET_NAME);
  var values = sheet.getDataRange().getValues();
  var rows = values.slice(1); // 1行目はヘッダー

  var total = 0;
  var byType = {};
  var details = [];

  rows.forEach(function (row) {
    var timestamp = row[0];
    if (!(timestamp instanceof Date)) return;
    if (timestamp < start || timestamp > end) return;

    var name = row[1];
    var type = row[5] || '未分類';
    var content = row[6];

    total++;
    byType[type] = (byType[type] || 0) + 1;
    details.push({ timestamp: timestamp, name: name, type: type, content: content });
  });

  details.sort(function (a, b) { return a.timestamp - b.timestamp; });

  return { total: total, byType: byType, details: details };
}

// ==== GA4（Analytics Data API）の集計 ====
function collectGA4Stats_(start, end) {
  var tz = Session.getScriptTimeZone();
  var request = {
    dateRanges: [{
      startDate: Utilities.formatDate(start, tz, 'yyyy-MM-dd'),
      endDate: Utilities.formatDate(end, tz, 'yyyy-MM-dd')
    }],
    dimensions: [{ name: 'eventName' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: {
      filter: {
        fieldName: 'eventName',
        inListFilter: { values: ['line_click', 'tel_click'] }
      }
    }
  };

  var response = AnalyticsData.Properties.runReport(request, GA4_PROPERTY_ID);
  var result = { line_click: 0, tel_click: 0 };

  if (response.rows) {
    response.rows.forEach(function (row) {
      var name = row.dimensionValues[0].value;
      var count = Number(row.metricValues[0].value);
      if (result.hasOwnProperty(name)) result[name] = count;
    });
  }

  return result;
}

// ==== 前回集計値の保存・取得（スクリプトプロパティを利用） ====
function getPreviousStats_() {
  var json = PropertiesService.getScriptProperties().getProperty('PREV_STATS');
  return json ? JSON.parse(json) : null;
}

function savePreviousStats_(contactStats, gaStats) {
  PropertiesService.getScriptProperties().setProperty('PREV_STATS', JSON.stringify({
    total: contactStats.total,
    line_click: gaStats.line_click,
    tel_click: gaStats.tel_click
  }));
}

// ==== メール送信 ====
function sendReportEmail_(period, contactStats, gaStats, prev) {
  var tz = Session.getScriptTimeZone();
  var startLabel = Utilities.formatDate(period.start, tz, 'M/d');
  var endLabel = Utilities.formatDate(period.end, tz, 'M/d');
  var subject = '【松井塗装】' + period.monthLabel + 'サイト反応レポート（' + startLabel + '〜' + endLabel + '）';

  function diffText(current, previous) {
    if (previous === null || previous === undefined) return '';
    var diff = current - previous;
    if (diff > 0) return ' (前回比 +' + diff + ')';
    if (diff < 0) return ' (前回比 ' + diff + ')';
    return ' (前回比 ±0)';
  }

  var summaryHtml =
    '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;">' +
    '<tr><th>項目</th><th>件数</th></tr>' +
    '<tr><td>お問い合わせ件数</td><td>' + contactStats.total + diffText(contactStats.total, prev ? prev.total : null) + '</td></tr>' +
    '<tr><td>LINEボタンクリック数</td><td>' + gaStats.line_click + diffText(gaStats.line_click, prev ? prev.line_click : null) + '</td></tr>' +
    '<tr><td>電話番号クリック数</td><td>' + gaStats.tel_click + diffText(gaStats.tel_click, prev ? prev.tel_click : null) + '</td></tr>' +
    '</table>';

  var typeRows = Object.keys(contactStats.byType).map(function (type) {
    return '<tr><td>' + escapeHtml_(type) + '</td><td>' + contactStats.byType[type] + '</td></tr>';
  }).join('');
  var typeHtml = contactStats.total === 0
    ? '<p>対象期間内のお問い合わせはありませんでした。</p>'
    : '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;"><tr><th>工事種別</th><th>件数</th></tr>' + typeRows + '</table>';

  var detailRows = contactStats.details.map(function (d) {
    return '<tr><td>' + Utilities.formatDate(d.timestamp, tz, 'yyyy/MM/dd HH:mm') + '</td><td>' +
      escapeHtml_(d.name) + '</td><td>' + escapeHtml_(d.type) + '</td><td>' + escapeHtml_(d.content) + '</td></tr>';
  }).join('');
  var detailHtml = contactStats.details.length === 0
    ? ''
    : '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;"><tr><th>日時</th><th>お名前</th><th>工事種別</th><th>お問い合わせ内容</th></tr>' + detailRows + '</table>';

  var body =
    '<p>' + period.monthLabel + '（' + startLabel + '〜' + endLabel + '）のサイト反応レポートです。</p>' +
    '<h3>■ 早見表</h3>' + summaryHtml +
    '<h3>■ 工事種別ごとの内訳</h3>' + typeHtml +
    '<h3>■ お問い合わせ詳細一覧</h3>' + detailHtml;

  MailApp.sendEmail({
    to: MAIL_TO,
    subject: subject,
    htmlBody: body
  });
}

function escapeHtml_(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
