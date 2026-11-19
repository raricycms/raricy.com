// 脚本侧要用的两档时长：样式在 src/styles-scss/abstracts/_variables.scss
// 的 $motion-duration / $feedback-duration。SCSS 变量进不了 JS，凡是脚本里
// 需要跟过渡对齐的地方都从这里取，不要再散落写数字。
export const MOTION_MS = 720;
export const FEEDBACK_MS = 240;
