// 凭据脱敏：raw、stderr、error 这类可能带着凭据的原文，进投影、卡片、档案和通知之前先过一遍。
// 宁可误伤一小段文字，不漏一个令牌。规则按形状匹配，不认任何产品。

const PLACEHOLDER = "[已脱敏]";

/** 名字里的凭据词：要成词（.、_、- 或首尾为界），不然 monkey、keyboard 这样的普通词也会被误伤。 */
const NAMED = /(^|[._-])(key|token|secret|password|credential)([._-]|$)/i;

/** 连写名（apikey、mysecret、dbpassword）：白名单前缀 + 凭据词结尾，普通词不靠前缀表就不会中。 */
const COMPOUND =
  /^(?:api|access|auth|app|aws|bearer|client|db|encryption|jwt|master|my|oauth|pg|private|refresh|secret|service|session|signing|ssh)?(?:key|token|secret|password|passwd|credential)s?$/i;

const named = (name: string) => NAMED.test(name) || COMPOUND.test(name);

/** 顺序即优先级：成块和带名字的在前，裸令牌在后，整条授权头最后。 */
const PATTERNS: [RegExp, string | ((whole: string) => string)][] = [
  // 私钥整块
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[已脱敏的私钥]"],
  // 名字里带凭据词的「名=值」「名: 值」写法（含环境变量）
  [
    /[A-Za-z_][A-Za-z0-9_.-]*[ \t]*[:=][ \t]*["']?[^\s"',}{]{6,}["']?/g,
    (whole) => {
      const name = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(whole)![0];
      const sep = /^[A-Za-z_][A-Za-z0-9_.-]*([ \t]*[:=][ \t]*)/.exec(whole)![1];
      return named(name) ? name + sep + PLACEHOLDER : whole;
    },
  ],
  // 网址里的 用户:口令@
  [/((?:https?|ssh|ftp):\/\/)[^/\s:@]+:[^@\s]+@/gi, "$1" + PLACEHOLDER + "@"],
  // Bearer 令牌（大小写都算，HTTP 头经常被整个转成大写）
  [/bearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, "Bearer " + PLACEHOLDER],
  // 常见令牌形状
  [/sk-[A-Za-z0-9_-]{8,}/g, PLACEHOLDER],
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, PLACEHOLDER],
  [/[a-z]{4,8}_pat_[A-Za-z0-9_]{16,}/g, PLACEHOLDER],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, PLACEHOLDER],
  [/AKIA[0-9A-Z]{16}/g, PLACEHOLDER],
  [/AIza[0-9A-Za-z_-]{20,}/g, PLACEHOLDER],
  // JWT（三段点分 base64url，头一段以 eyJ 开头）
  [/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, PLACEHOLDER],
  // 整条授权头（放最后：先让上面的规则处理典型令牌，剩下的整段换）
  [/[A-Za-z-]*[Aa]uthorization\s*[:=]\s*\S[^\n]*/g, PLACEHOLDER],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement as string);
  return out;
}
