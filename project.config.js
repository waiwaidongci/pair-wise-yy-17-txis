module.exports = {
  port: 3912,
  title: '钟乳石断面摄影测量复核台',
  lede: '每月标准照登记标尺编号与像素/毫米换算；照片缺失或换算偏差超过 1% 只进待重拍，另一位测量员确认连续两次增长同向且差值不超过 0.2 mm 才通过。样点基准或历史拍摄更正会使相关增长失效重算。',
  tones: {
    '待重拍': 'bad',
    '待确认': 'warn',
    '已通过': 'ok',
    '已失效': 'bad'
  },
  collections: {
    sites: { label: '样点档案' },
    rulers: { label: '标尺台账' },
    reviews: { label: '复核记录' }
  },
  stats: [
    { label: '样点', collection: 'sites' },
    { label: '标尺', collection: 'rulers' },
    { label: '待重拍', collection: 'reviews', filter: { field: 'status', value: '待重拍' } },
    { label: '待确认', collection: 'reviews', filter: { field: 'status', value: '待确认' } },
    { label: '已失效待重算', collection: 'reviews', filter: { field: 'status', value: '已失效' } }
  ],
  views: [
    {
      id: 'dashboard',
      label: '待办看板',
      type: 'dashboard',
      focusTitle: '未闭环复核（待重拍 / 待确认 / 已失效）',
      focus: { collection: 'reviews', field: 'status', values: ['待重拍', '待确认', '已失效'], limit: 10 }
    },
    {
      id: 'sites',
      label: '样点档案',
      collection: 'sites',
      sortField: 'pointCode',
      formTitle: '新增样点',
      listTitle: '样点列表',
      submitLabel: '建档',
      searchPlaceholder: '搜索样点编号、洞穴、分区',
      searchFields: ['pointCode', 'cave', 'zone', 'note'],
      titleFields: ['pointCode', 'cave'],
      summaryFields: ['zone', 'note'],
      detailFields: [
        { label: '基准断面长度', name: 'baselineMm', suffix: 'mm' }
      ],
      fields: [
        { label: '样点编号', name: 'pointCode', required: true, placeholder: '如 D-07' },
        { label: '洞穴', name: 'cave', required: true },
        { label: '分区', name: 'zone', required: true },
        { label: '基准断面长度 (mm)', name: 'baselineMm', type: 'number', required: true, step: '0.001' },
        { label: '备注', name: 'note', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'rulers',
      label: '标尺台账',
      collection: 'rulers',
      sortField: 'rulerCode',
      formTitle: '登记标尺',
      listTitle: '标尺列表（占用状态随复核动态变化）',
      submitLabel: '登记标尺',
      searchPlaceholder: '搜索标尺编号',
      searchFields: ['rulerCode', 'note'],
      titleFields: ['rulerCode'],
      summaryFields: ['note'],
      detailFields: [
        { label: '标定长度', name: 'caliberMm', suffix: 'mm' },
        { label: '标定像素', name: 'caliberPx', suffix: 'px' },
        { label: '每像素毫米', name: 'mmPerPx', computed: true, digits: 5 }
      ],
      fields: [
        { label: '标尺编号', name: 'rulerCode', required: true, placeholder: '如 R-101' },
        { label: '标定长度 (mm)', name: 'caliberMm', type: 'number', required: true, step: '0.001' },
        { label: '标定像素 (px)', name: 'caliberPx', type: 'number', required: true, step: '1' },
        { label: '备注', name: 'note', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'reviews',
      label: '复核记录',
      collection: 'reviews',
      sortField: 'date',
      formTitle: '登记月度复核',
      listTitle: '复核履历（按拍摄日期）',
      submitLabel: '提交判定',
      searchPlaceholder: '搜索样点、标尺、测量员、确认人',
      searchFields: ['surveyor', 'checker', 'memo', 'photoUrl'],
      statusField: 'status',
      statusOptions: ['待重拍', '待确认', '已通过', '已失效'],
      titleFields: ['siteLabel', 'date'],
      relation: { collection: 'sites', localKey: 'siteId', labelFields: ['pointCode', 'cave'] },
      summaryFields: ['memo', 'invalidReason'],
      detailFields: [
        { label: '标尺', name: 'rulerCode', computed: true },
        { label: '拍摄测量员', name: 'surveyor' },
        { label: '断面长度', name: 'lengthMm', suffix: 'mm' },
        { label: '较锚点增长', name: 'growthText', computed: true },
        { label: '换算偏差', name: 'deviationText', computed: true },
        { label: '确认测量员', name: 'checker' }
      ],
      fields: [
        { label: '样点', name: 'siteId', type: 'relation', collection: 'sites', labelFields: ['pointCode', 'cave', 'zone'], required: true, wide: true },
        { label: '标尺（同点未结链条可继续使用，占用他人样点时禁用）', name: 'rulerId', type: 'ruler', collection: 'rulers', required: true, wide: true },
        { label: '拍摄日期', name: 'date', type: 'date', required: true },
        { label: '拍摄测量员', name: 'surveyor', required: true },
        { label: '标准照链接', name: 'photoUrl', placeholder: '缺失将只进待重拍' },
        { label: '标尺读数 (mm)', name: 'caliberMm', type: 'number', required: true, step: '0.001' },
        { label: '标尺读数 (px)', name: 'caliberPx', type: 'number', required: true, step: '1' },
        { label: '断面长度 (px)', name: 'lengthPx', type: 'number', required: true, step: '0.01' },
        { label: '备注', name: 'memo', type: 'textarea', wide: true }
      ]
    }
  ],
  // 工作流按钮：仅作页面声明，判定全部在 rules.js + server.js 的专用端点中执行
  flows: [
    { id: 'reshoot', label: '登记重拍', collection: 'reviews', when: ['待重拍', '已失效'], kind: 'reshoot' },
    { id: 'confirm', label: '复核确认', collection: 'reviews', when: ['待确认'], kind: 'confirm' },
    { id: 'correct', label: '更正历史拍摄', collection: 'reviews', when: ['已通过'], kind: 'correct', danger: true },
    { id: 'baseline', label: '基准更正', collection: 'sites', kind: 'baseline', danger: true }
  ]
};
