/**
 * English copy —— 与 zh.ts 一一对应。
 *
 * 类型写成 `Record<MsgKey, string>`，**少一条就编译不过** —— 这就是不漏译的保证。
 * 不要给这个对象加 `as const`：那样会退回字面量类型，反而让缺键检查失效。
 *
 * 复数：英文必须写 `单数形||复数形`，由 t(key, { n }) 按 n 挑选（见 zh.ts 顶部注释）。
 */
import type { MsgKey } from './zh';

export const en: Record<MsgKey, string> = {
  /* ---------------- 通用 / 页头 ---------------- */

  'meta.create.title': 'Create a secret message · 1tmsg',
  'meta.create.desc':
    'Create a burn-after-reading secret message: encrypted in your browser, and the server only ever stores ciphertext it cannot read.',
  'meta.view.title': 'View a secret message · 1tmsg',
  'brand.tagline': 'Burn after reading · end-to-end encrypted',
  'lang.toEnglish': 'Switch to English',
  'lang.toChinese': '切换到中文',
  'nav.github': 'View the source on GitHub',

  /* ---------------- 创建页 · 页头与说明 ---------------- */

  'create.badge': 'The server cannot read it',
  'create.h1': 'Create a secret message',
  'create.sub':
    'It is encrypted in your browser, so only someone who has the link (and the password) can open it — the server can only store ciphertext it cannot read.',

  /* ---------------- 创建页 · 编辑区 ---------------- */

  'create.msgTitle': 'Message',
  'create.modeEdit': 'Write',
  'create.modeView': 'Preview',
  'create.noteLabel': 'Note',
  'create.noteOptional': 'optional',
  'create.noteSide': 'Visible to the recipient only',
  'create.notePh': 'One line for the recipient, e.g. the file you asked for',
  'create.bodyLabel': 'Body',
  'create.bodyAria': 'Message body',
  'editor.countSuffix': 'characters · Markdown',
  'editor.mdBold': 'Bold',
  'editor.mdItalic': 'Italic',
  'editor.mdList': 'List',
  'editor.mdCode': 'Code',
  'editor.mdLink': 'Link',
  'editor.mdImage': 'Insert image',
  'editor.placeholderPlain': '# Heading\n\nSupports **Markdown**, lists and code blocks.',
  'editor.placeholderImage':
    '# Heading\n\nSupports **Markdown**, lists and code blocks — you can also paste or drop images here.',
  'editor.attachTip':
    'Drag, paste or use the toolbar to add images — {single} each, {total} total, {max} max',
  'editor.addImage': 'Add image',
  'editor.remove': 'Remove',
  'editor.wrapBold': 'bold text',
  'editor.wrapItalic': 'italic text',
  'editor.wrapLink': 'link text',
  'editor.wrapListItem': 'list item',
  'editor.notImage': 'Only image files are supported',
  'editor.tooManyImages': 'At most {n} image||At most {n} images',
  'editor.fileTooLarge': '{name} is over {limit}',
  'editor.totalTooLarge': 'Images add up to more than {limit}',
  'editor.fileReadFailed': 'Could not read {name}',
  'editor.imageName': 'image-{n}',
  'editor.inserted': 'Added {n} image||Added {n} images',

  /* ---------------- 创建页 · 查看与销毁 ---------------- */

  'create.lifeCard': 'Viewing & destruction',
  'create.burn': 'Burn after reading',
  'create.burnTipOn': 'Deleted from the server the moment it is opened',
  'create.burnTipOff': 'Off — set a view limit below',
  'create.burnMutOn': 'Turn it off to set your own view limit',
  'create.viewsLabel': 'View limit',
  'create.viewsSide': '1 – 100',
  'create.viewsDec': 'Decrease',
  'create.viewsInc': 'Increase',
  'create.ttlLabel': 'Expires in',
  'create.ttlSide': '7 days max',
  'ttl.h1': '1 hour',
  'ttl.h6': '6 hours',
  'ttl.h12': '12 hours',
  'ttl.d1': '1 day',
  'ttl.d3': '3 days',
  'ttl.d7': '7 days',
  'create.pw': 'Password',
  'create.pwTipOn': 'Link plus password required to decrypt',
  'create.pwTipOff': 'Off — the link alone is enough to open it',
  'create.pwMutOn': 'Turn it off and the link alone will open it',
  'create.pwMutOff': 'Turn it on and a password will be required',
  'create.pwPh': 'Set a password (6 characters or more)',
  'create.pwShow': 'Show password',
  'create.pwHide': 'Hide password',
  'create.submit': 'Create and copy link',
  'create.micro': 'Encrypted locally with AES-256-GCM — the key never leaves your browser',

  /* ---------------- 创建页 · 摘要条 ---------------- */

  'sum.expire': 'Expires',
  'sum.afterTtl': 'in {ttl}',
  'sum.burn': 'Burn after reading',
  'sum.burnVal': 'Deleted after 1 view',
  'sum.views': 'View limit',
  'sum.viewsVal': 'Up to {n} view||Up to {n} views',
  'sum.pw': 'Password',
  'sum.pwVal': 'Password required',

  /* ---------------- 创建页 · 提示与进度 ---------------- */

  'create.errEmpty': 'Write something first',
  'create.errPwShort': 'Use at least {n} characters',
  'create.progressEncrypt': 'Encrypting locally…',
  'create.progressUpload': 'Uploading image {i}/{total}…',
  'create.progressConfirm': 'Finishing up…',
  'create.errAutoCopy': 'Could not copy automatically — copy the link by hand',
  'create.errTooLarge': 'Text is too large ({size}); the limit is {limit}',
  'create.errFailed': 'Could not create the message. Please try again.',

  /* ---------------- 已创建 ---------------- */

  'sent.h1': 'Message created',
  'sent.sub1': 'Just send the link to them. The part of the link after',
  'sent.sub2':
    'is the decryption key — it lives only in the link and is never sent to the server.',
  'sent.copy': 'Copy',
  'sent.copied': 'Copied',
  'sent.copyFailed': 'Copy failed',
  'sent.qrHint': 'Scan to open on your phone',
  'sent.qrAria': 'QR code for the message link',
  'sent.burnKey': 'Burn after reading',
  'sent.burnVal': 'Destroyed after {n} view||Destroyed after {n} views',
  'sent.ttlKey': 'Expires in',
  'sent.keyKey': 'Decryption key',
  'sent.keyValLink': 'In the link only',
  'sent.keyValPw': 'Link + password',
  'sent.warn1': 'Send it through a channel you trust. ',
  'sent.warn2': 'anyone who has the link can read this message',
  'sent.warn3': ' — and once forwarded, a link cannot be recalled.',
  'sent.info':
    'The server only holds ciphertext and an expiry time. Even if the database leaked, it would not reveal what you wrote.',
  'sent.again': 'Create another',

  /* ---------------- 查看页 · 页头与状态 ---------------- */

  'view.badge': 'Decrypted in your browser only',
  'view.loadingTitle': 'Preparing to decrypt',
  'view.loadingBody':
    'Reading the key from the link and asking the server about this message.',
  'view.fatalTitle': 'This message cannot be opened',
  'view.fatalNote1': 'The decryption key exists only after the',
  'view.fatalNote2':
    'in the original link. The server has never seen it, so it cannot recover a truncated link for you.',
  'view.createNew': 'Create a new message',

  /* ---------------- 查看页 · 密码解锁 ---------------- */

  'view.unlockTitle': 'This message is password protected',
  'view.unlockSub':
    'Enter the password the sender gave you. It is never sent to the server — verification and decryption both happen in your browser.',
  'view.pwLabel': 'Password',
  'view.pwSide': 'Only a successful decryption counts as a view',
  'view.pwPh': 'Enter password',
  'view.unlockBtn': 'Decrypt and view',
  'view.unlockWarn1': 'A wrong password does not use up a view — ',
  'view.unlockWarn2': 'only a successful decryption counts',
  'view.unlockWarn3': '.',
  'view.unlockMicro': 'PBKDF2 → HKDF → AES-256-GCM, all local',

  /* ---------------- 查看页 · 正文 ---------------- */

  'view.badgeLocal': 'Decrypted locally',
  'view.copy': 'Copy',
  'view.copyAll': 'Copy everything',
  'view.copyAria': 'Copy all content',
  'view.copied': 'Copied',
  'view.copiedAll': 'Copied everything',
  'view.errNothingToCopy': 'This message has no text to copy',
  'view.errCopyFailed': 'Copy failed — select the text and copy manually',
  'view.ctaTitle': 'Want to send one safely too?',
  'view.ctaBtn': 'Create my own',
  'view.ctaMicro': 'No sign-up · encrypted in the browser · destroyed once opened',
  'view.readDone1': 'This was a burn-after-reading message — the ciphertext on the server ',
  'view.readDone2': 'has already been deleted',
  'view.readDone3':
    '. Do not close or reload this page, or the content cannot be opened again.',
  'view.badgeDestroyed': 'Burn after reading · destroyed',
  'view.badgeRemaining':
    'Decrypted locally · {n} view left||Decrypted locally · {n} views left',
  'view.expiryIn': 'Expires in {time}',
  'view.expiryExpired': 'Expired',

  /* ---------------- 查看页 · 失败与加载 ---------------- */

  'view.errBadLinkTitle': 'The link is incomplete',
  'view.errBadLinkBody': 'This address does not look like a valid message link.',
  'view.errNoKeyBody':
    'The link is missing its decryption key (the part after #) — it was probably truncated while copying or forwarding. Ask the sender for the full link again.',
  'view.errKeyLostBody': 'The decryption key is gone. Open the full link again.',
  'view.errPendingTitle': 'The sender is still uploading images',
  'view.errPendingBody':
    'Not all images in this message have finished uploading, so some would be missing. Wait a moment and open the link again.',
  'view.errPendingRetryBody':
    'Not all images have finished uploading. Wait a moment and open the link again.',
  'view.errGoneTitle': 'This message has been destroyed',
  'view.errGoneExpiredBody':
    'It passed its expiry time, and the ciphertext on the server has been deleted.',
  'view.errGoneConsumedBody':
    'It reached its view limit, and the ciphertext on the server has been deleted.',
  'view.errGoneBody': 'The ciphertext on the server has been deleted. It cannot be opened again.',
  'view.errSaltTitle': 'Incomplete data',
  'view.errSaltBody': 'This message is missing the salt needed to decrypt it, so it cannot be opened.',
  'view.errNotFoundTitle': 'Message not found',
  'view.errUnavailableTitle': 'Cannot open right now',
  'view.errRetryLater': 'Please try again shortly.',
  'view.errLockedTitle': 'Message locked',
  'view.errLockedBody':
    'Too many wrong passwords — to protect the content, this message has been deleted.',
  'view.errDecryptTitle': 'Decryption failed',
  'view.errDecryptBody':
    'This link could not unlock the content. Check that the link is complete and unmodified.',
  'view.errOpenFailed': 'Could not open it. Please try again.',
  'view.errOpenFailedShort': 'Open failed',
  'view.errEmptyPassword': 'Enter the password',
  'view.progressDecrypt': 'Decrypting locally…',
  'view.progressImagesTitle': 'Fetching images',
  'view.progressImages':
    'Fetching image {done}/{total}…||Fetching images {done}/{total}…',
  'view.errImagesFailed': '{n} image could not be fetched||{n} images could not be fetched',

  /* ---------------- 时间与体积格式化 ---------------- */

  'unit.day': '{n} day||{n} days',
  'unit.hour': '{n} hour||{n} hours',
  'unit.minute': '{n} minute||{n} minutes',
  'unit.second': '{n} second||{n} seconds',
  'unit.expired': 'Expired',

  /* ---------------- Markdown 渲染占位 ---------------- */

  'md.imageMissing': 'Missing image · {alt}',
  'md.imageBlocked': 'External image blocked',

  /* ---------------- 服务端错误码（按 code 映射，见 src/client/api.ts） ---------------- */

  'err.network': 'Network request failed. Check your connection and try again.',
  'err.uploadFailed': 'Image upload failed. Check your connection and try again.',
  'err.downloadFailed': 'Image download failed. Check your connection and try again.',
  'err.http': 'Request failed (HTTP {status})',
  'err.badResponse': 'The server returned something that could not be parsed',
  'err.bad_request': 'Invalid request — reload the page and try again',
  'err.bad_json': 'The request could not be parsed — reload the page and try again',
  'err.too_large': 'Content is over the size limit',
  'err.not_found': 'This message does not exist or has been destroyed',
  'err.gone': 'This message has been destroyed or has expired',
  'err.not_ready': 'The message is still uploading. Try again shortly.',
  'err.password_required': 'This message needs a password',
  'err.bad_password': 'Wrong password',
  'err.locked': 'Too many wrong passwords — this message has been locked',
  'err.unauthorized': 'The credential is invalid or has expired',
  'err.forbidden': 'The credential is invalid or has expired',
  'err.images_disabled': 'This deployment does not have images enabled',
  'err.incomplete': 'Some images have not finished uploading',
  'err.rate_limited': 'Too many messages created — try again in {n} seconds||Too many messages created — try again in {n} seconds',
  'err.id_collision': 'The service is temporarily unavailable. Try again.',
  'err.method_not_allowed': 'That request method is not allowed',
  'err.length_required': 'The request is missing its length',
  'err.asset_missing': 'A page asset is missing',
  'err.internal': 'Internal server error',
  'err.unknown': 'Something went wrong. Please try again.',
};
