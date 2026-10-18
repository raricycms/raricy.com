import type { Metadata } from 'next';
import GeometryMenu from './GeometryMenu';

export const metadata: Metadata = {
  title: '几何计算器 - 聪明山工具箱',
  description:
    '平面与空间几何、圆锥曲线、多项式求导与拉格朗日乘数法计算。全部在浏览器本地完成，结果精确输出。',
};

export default function GeometryToolPage() {
  return <GeometryMenu />;
}
