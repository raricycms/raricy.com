import type { Metadata } from 'next';
import ConverterApp from './ConverterApp';

export const metadata: Metadata = {
  title: '格式转换器 - 聪明山工具箱',
  description: '图片、音频、视频、文档、表格、文本、电子书与压缩包的格式转换。文件只在你的浏览器中处理，不会上传。',
};

export default function ConvertToolPage() {
  return <ConverterApp />;
}
