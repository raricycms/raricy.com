// clipboard-limits.ts — 云剪贴板的**对外可见上限**（零依赖，服务端与客户端共用）。
//
// 为什么单独一个文件：这两个数同时被「服务端写入闸门 / API 路由」和「客户端上传表单」
// 使用。把常量留在 clipboard-service.ts 会被客户端 import 拖进 prisma（server-only），
// 于是前端只能手抄数字 —— 而手抄已经漂过一次（正文 250000 vs 50000、标题 30 vs 40，
// 用户本地拦不住、提交后才被服务端拒）。改数值只改这里。
export const CLIP_TITLE_MAX = 40;
export const CLIP_CONTENT_MAX = 50000;
