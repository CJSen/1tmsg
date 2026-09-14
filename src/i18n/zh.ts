/**
 * 中文文案字典 —— **键表的唯一真源**。
 *
 * 约定（三条，都很硬）：
 *
 *  1. **键名以本文件为准。** `MsgKey = keyof typeof zh`，en.ts 必须写成
 *     `Record<MsgKey, string>`，少一条就编译不过。这就是「不漏译」的保证手段。
 *
 *  2. **复数用 `||` 分隔**：`'最多 {n} 次||最多 {n} 次'` —— 竖线前是 n===1 的形，
 *     竖线后是其余。中文没有复数，所以中文条目通常不写竖线；英文必须写。
 *     取值走 `t(key, { n })`，`n` 是数字时才会按单复数挑选。
 *
 *  3. **文案里不写 HTML。** 需要局部加粗/斜体的地方一律拆成相邻的多个键
 *     （例如 sent.warn1/2/3），由 HTML 用相邻元素承载。原因：运行期切换语言走
 *     `textContent`，走 `innerHTML` 就与 spec「永不把未清理的内容塞进 innerHTML」
 *     的硬规则冲突，宁可多几个键。
 *
 * 另有两条「不进本文件」的例外，见 src/client/editor.ts 与 create.ts：
 *   - 正文占位符（两种：带图片 / 不带图片）按 __ENABLE_IMAGES__ 在运行期选，
 *     但仍然走字典（editor.placeholderPlain / editor.placeholderImage）。
 *   - 附件托盘提示（editor.attachTip）带 4 个参数，由 editor.ts 在开关为真时渲染；
 *     关闭图片时托盘整体 hidden，静态 HTML 里那份文案用户永远看不到。
 */
export const zh = {
  /* ---------------- 通用 / 页头 ---------------- */

  'meta.create.title': '创建秘密消息 · 1tmsg',
  'meta.create.desc':
    '创建一条阅后即焚的秘密消息：内容在你的浏览器里加密，服务器只保存看不懂的密文。',
  'meta.view.title': '查看秘密消息 · 1tmsg',
  'brand.tagline': '阅后即焚 · 端到端加密',
  'lang.toEnglish': '切换到英文',
  'lang.toChinese': '切换到中文',
  'nav.github': '在 GitHub 上查看源码',

  /* ---------------- 创建页 · 页头与说明 ---------------- */

  'create.badge': '服务器看不到明文',
  'create.h1': '创建一条秘密消息',
  'create.sub':
    '内容在你的浏览器里加密，只有拿到链接（和密码）的人才打开得了；服务器只能保存一段看不懂的密文。',

  /* ---------------- 创建页 · 编辑区 ---------------- */

  'create.msgTitle': '消息内容',
  'create.modeEdit': '编辑',
  'create.modeView': '预览',
  'create.noteLabel': '备注',
  'create.noteOptional': '可选',
  'create.noteSide': '仅收件人可见',
  'create.notePh': '给收件人一句话，例如：给你的那份文件',
  'create.bodyLabel': '正文',
  'create.bodyAria': '消息正文',
  'editor.countSuffix': '字 · Markdown',
  'editor.mdBold': '加粗',
  'editor.mdItalic': '斜体',
  'editor.mdList': '列表',
  'editor.mdCode': '代码',
  'editor.mdLink': '链接',
  'editor.mdImage': '插入图片',
  'editor.placeholderPlain': '# 标题\n\n正文支持 **Markdown**、列表、代码块。',
  'editor.placeholderImage':
    '# 标题\n\n正文支持 **Markdown**、列表、代码块，也可以直接粘贴或拖入图片。',
  'editor.attachTip':
    '拖拽 / 粘贴 / 点图标插入图片，单张 ≤ {single}，合计 ≤ {total}，最多 {max} 张',
  'editor.addImage': '添加图片',
  'editor.remove': '移除',
  'editor.wrapBold': '加粗文字',
  'editor.wrapItalic': '斜体文字',
  'editor.wrapLink': '链接文字',
  'editor.wrapListItem': '列表项',
  'editor.notImage': '只支持图片文件',
  'editor.tooManyImages': '最多 {n} 张图片||最多 {n} 张图片',
  'editor.fileTooLarge': '{name} 超过 {limit}',
  'editor.totalTooLarge': '图片合计超过 {limit}',
  'editor.fileReadFailed': '{name} 读取失败',
  'editor.imageName': '图片-{n}',
  'editor.inserted': '已插入 {n} 张图片||已插入 {n} 张图片',

  /* ---------------- 创建页 · 查看与销毁 ---------------- */

  'create.lifeCard': '查看与销毁',
  'create.burn': '阅后即焚',
  'create.burnTipOn': '被查看一次后立即从服务器删除',
  'create.burnTipOff': '已关闭，查看次数可在下方自定义',
  'create.burnMutOn': '关闭后可自定义查看次数',
  'create.viewsLabel': '可查看次数',
  'create.viewsSide': '1 – 100',
  'create.viewsDec': '减少',
  'create.viewsInc': '增加',
  'create.ttlLabel': '过期时间',
  'create.ttlSide': '最长 7 天',
  'ttl.h1': '1 小时',
  'ttl.h6': '6 小时',
  'ttl.h12': '12 小时',
  'ttl.d1': '1 天',
  'ttl.d3': '3 天',
  'ttl.d7': '7 天',
  'create.pw': '密码保护',
  'create.pwTipOn': '需要链接 + 密码才能解密',
  'create.pwTipOff': '未开启，只凭链接即可打开',
  'create.pwMutOn': '关闭后只凭链接即可打开',
  'create.pwMutOff': '开启后需要密码才能解密',
  'create.pwPh': '设置一个密码（至少 6 位）',
  'create.pwShow': '显示密码',
  'create.pwHide': '隐藏密码',
  'create.submit': '创建并复制链接',
  'create.micro': 'AES-256-GCM 本地加密，密钥不会离开你的浏览器',

  /* ---------------- 创建页 · 摘要条 ---------------- */

  'sum.expire': '自动失效',
  'sum.afterTtl': '{ttl}后',
  'sum.burn': '阅后即焚',
  'sum.burnVal': '查看 1 次后删除',
  'sum.views': '可查看',
  'sum.viewsVal': '最多 {n} 次||最多 {n} 次',
  'sum.pw': '密码保护',
  'sum.pwVal': '需要密码解密',

  /* ---------------- 创建页 · 提示与进度 ---------------- */

  'create.errEmpty': '至少写点什么再创建',
  'create.errPwShort': '密码至少 {n} 位',
  'create.progressEncrypt': '正在本地加密…',
  'create.progressUpload': '正在上传图片 {i}/{total}…',
  'create.progressConfirm': '正在确认…',
  'create.errAutoCopy': '自动复制失败，请手动复制链接',
  'create.errTooLarge': '文字内容过大（{size}），上限 {limit}',
  'create.errFailed': '创建失败，请重试',

  /* ---------------- 已创建 ---------------- */

  'sent.h1': '消息已创建',
  'sent.sub1': '把链接发给对方就好。链接中',
  'sent.sub2': '后面那段是解密密钥，它只存在于链接里，不会被发送到服务器。',
  'sent.copy': '复制',
  'sent.copied': '已复制',
  'sent.copyFailed': '复制失败',
  'sent.burnKey': '阅后即焚',
  'sent.burnVal': '查看 {n} 次后销毁||查看 {n} 次后销毁',
  'sent.ttlKey': '过期时间',
  'sent.keyKey': '解密密钥',
  'sent.keyValLink': '仅在链接里',
  'sent.keyValPw': '链接 + 密码',
  'sent.warn1': '请通过可信渠道发送。',
  'sent.warn2': '任何拿到链接的人都能查看这条消息',
  'sent.warn3': '，链接转发后无法撤回。',
  'sent.info': '服务器上只存了密文和过期时间。即使数据库泄露，也读不出你和对方说了什么。',
  'sent.again': '再创建一条',

  /* ---------------- 查看页 · 页头与状态 ---------------- */

  'view.badge': '密文仅在本地解密',
  'view.loadingTitle': '正在准备解密',
  'view.loadingBody': '读取链接里的密钥，并向服务器确认这条消息的状态。',
  'view.fatalTitle': '无法打开这条消息',
  'view.fatalNote1': '解密密钥只存在于原始链接的',
  'view.fatalNote2': '之后。服务器从未见过它，因此也无法帮你恢复被截断的链接。',
  'view.createNew': '创建一条新消息',

  /* ---------------- 查看页 · 密码解锁 ---------------- */

  'view.unlockTitle': '这条消息受密码保护',
  'view.unlockSub':
    '输入发送者给你的密码。密码不会发送到服务器，验证与解密都在你的浏览器里完成。',
  'view.pwLabel': '密码',
  'view.pwSide': '解密成功后才会计入查看次数',
  'view.pwPh': '输入密码',
  'view.unlockBtn': '解密并查看',
  'view.unlockWarn1': '密码错误不会消耗查看次数；',
  'view.unlockWarn2': '只有解密成功那一次才算',
  'view.unlockWarn3': '。',
  'view.unlockMicro': 'PBKDF2 → HKDF → AES-256-GCM，全程本地执行',

  /* ---------------- 查看页 · 正文 ---------------- */

  'view.badgeLocal': '已在本地解密',
  'view.copy': '复制',
  'view.copyAll': '复制全部内容',
  'view.copyAria': '复制全部内容',
  'view.copied': '已复制',
  'view.copiedAll': '已复制全部内容',
  'view.errNothingToCopy': '这条消息没有可复制的文本',
  'view.errCopyFailed': '复制失败，请手动选中内容复制',
  'view.ctaTitle': '也想安全地发一条？',
  'view.ctaBtn': '我也要创建一条',
  'view.ctaMicro': '无需注册 · 内容只在浏览器加解密 · 打开一次即销毁',
  'view.readDone1': '这是一条阅后即焚消息，服务器上的密文',
  'view.readDone2': '已经删除',
  'view.readDone3': '。请不要关闭或刷新页面，否则内容无法再次打开。',
  'view.badgeDestroyed': '阅后即焚 · 已销毁',
  'view.badgeRemaining': '已在本地解密 · 还可查看 {n} 次||已在本地解密 · 还可查看 {n} 次',
  'view.expiryIn': '{time} 后失效',
  'view.expiryExpired': '已过期',

  /* ---------------- 查看页 · 失败与加载 ---------------- */

  'view.errBadLinkTitle': '链接不完整',
  'view.errBadLinkBody': '这个地址看起来不像是有效的一条消息链接。',
  'view.errNoKeyBody': '链接里缺少解密密钥（# 后面那一段），可能是在复制或转发时被截断了。请向发送者重新索要完整链接。',
  'view.errKeyLostBody': '解密密钥已丢失，请重新打开完整链接。',
  'view.errPendingTitle': '发送者还在上传图片',
  'view.errPendingBody': '这条消息里的图片还没有全部传完，现在打开会缺图。请稍等片刻再重新打开这个链接。',
  'view.errPendingRetryBody': '图片还没有全部传完。请稍等片刻再重新打开这个链接。',
  'view.errGoneTitle': '这条消息已经销毁',
  'view.errGoneExpiredBody': '它已超过设定的过期时间，服务器上的密文已被删除。',
  'view.errGoneConsumedBody': '它已经被查看完设定的次数，服务器上的密文已被删除。',
  'view.errGoneBody': '服务器上的密文已被删除，无法再次打开。',
  'view.errSaltTitle': '数据不完整',
  'view.errSaltBody': '这条消息缺少解密所需的盐值，无法打开。',
  'view.errNotFoundTitle': '找不到这条消息',
  'view.errUnavailableTitle': '暂时无法打开',
  'view.errRetryLater': '请稍后重试。',
  'view.errLockedTitle': '消息已被锁定',
  'view.errLockedBody': '密码连续输错次数过多，为保护内容，这条消息已被删除。',
  'view.errDecryptTitle': '解密失败',
  'view.errDecryptBody': '无法用这条链接解开内容。请确认链接完整、未被修改。',
  'view.errOpenFailed': '打开失败，请重试',
  'view.errOpenFailedShort': '打开失败',
  'view.errEmptyPassword': '请输入密码',
  'view.progressDecrypt': '正在本地解密…',
  'view.progressImagesTitle': '正在取回图片',
  'view.progressImages': '正在取回 {done}/{total} 张图片…||正在取回 {done}/{total} 张图片…',
  'view.errImagesFailed': '{n} 张图片没能取回||{n} 张图片没能取回',

  /* ---------------- 时间与体积格式化 ---------------- */

  'unit.day': '{n} 天||{n} 天',
  'unit.hour': '{n} 小时||{n} 小时',
  'unit.minute': '{n} 分钟||{n} 分钟',
  'unit.second': '{n} 秒||{n} 秒',
  'unit.expired': '已失效',

  /* ---------------- Markdown 渲染占位 ---------------- */

  'md.imageMissing': '图片缺失 · {alt}',
  'md.imageBlocked': '外部图片已阻止',

  /* ---------------- 服务端错误码（按 code 映射，见 src/client/api.ts） ---------------- */

  'err.network': '网络连接失败，请检查网络后重试',
  'err.uploadFailed': '图片上传失败，请检查网络后重试',
  'err.downloadFailed': '图片下载失败，请检查网络后重试',
  'err.http': '请求失败（HTTP {status}）',
  'err.badResponse': '服务器返回了无法解析的内容',
  'err.bad_request': '请求参数不正确，请刷新页面后重试',
  'err.bad_json': '请求参数无法解析，请刷新页面后重试',
  'err.too_large': '内容体积超出限制',
  'err.not_found': '消息不存在或已被销毁',
  'err.gone': '消息已被销毁或已过期',
  'err.not_ready': '消息还在上传中，请稍后再试',
  'err.password_required': '这条消息需要密码',
  'err.bad_password': '密码不正确',
  'err.locked': '密码错误次数过多，这条消息已被锁定',
  'err.unauthorized': '凭证无效或已过期',
  'err.forbidden': '凭证无效或已过期',
  'err.images_disabled': '本服务未启用图片功能',
  'err.incomplete': '还有图片没有上传完成',
  'err.rate_limited': '创建太频繁了，请 {n} 秒后再试',
  'err.id_collision': '服务暂时不可用，请重试',
  'err.method_not_allowed': '请求方法不被允许',
  'err.length_required': '请求缺少长度信息',
  'err.asset_missing': '页面资源缺失',
  'err.internal': '服务器内部错误',
  'err.unknown': '操作失败，请重试',
} as const;

/** 文案键。以中文表为准 —— 新增文案先在这里加键。 */
export type MsgKey = keyof typeof zh;
