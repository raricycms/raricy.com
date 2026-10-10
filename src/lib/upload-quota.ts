/** 网络上传落库时的存储配额拒绝；路由映射为现有的 400 文案。 */
export class UploadQuotaError extends Error {
  constructor() { super('上传超过存储配额'); this.name = 'UploadQuotaError'; }
}
