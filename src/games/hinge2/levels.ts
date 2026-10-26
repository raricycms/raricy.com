import type { Level, Node, Surface } from './engine';

const n = (id: string, name: string, x: number, y: number, surface: Surface, seal = false): Node => ({ id, name, x, y, surface, seal });

export const LEVELS: readonly Level[] = [
  {
    id: 'turn', title: '转页', subtitle: '整张纸，都是机关', color: '#dfaa7d',
    instruction: '转动黄铜轮，让纸上的路接上两侧的白色平台。点击路面上的圆点行走，拾取菱形印记后抵达拱门。',
    mechanics: ['turn'], start: 'start', goal: 'goal',
    nodes: [
      n('start', '起点', -4.1, 0, 'fixed'), n('entry', '左侧平台', -3.2, 0, 'fixed'),
      n('a', '纸页入口', 0, 3.2, 'paper'), n('b', '长廊', 0, 1.2, 'paper'),
      n('seal', '印记平台', 1.2, 1.2, 'paper', true), n('c', '转角', 1.2, 0, 'paper'), n('d', '纸页出口', 3.2, 0, 'paper'),
      n('exit', '右侧平台', 3.2, 0, 'fixed'), n('goal', '终点', 4.1, 0, 'fixed'),
    ],
    edges: [['start', 'entry'], ['a', 'b'], ['b', 'seal'], ['seal', 'c'], ['c', 'd'], ['exit', 'goal']],
    hints: ['白色平台固定在纸页外；黄铜轮会转动整张纸，也会带着纸上的人一起转。', '先顺时针转一次，从左侧登上纸页。走过印记后，在纸上逆时针转回去。'],
  },
  {
    id: 'mirror', title: '镜廊', subtitle: '倒影也有一条路', color: '#83b9b6',
    instruction: '蓝色半透明的桥是镜中道路。转动镜面，倒影与站在倒影上的人都会改变位置。',
    mechanics: ['mirror'], start: 'start', goal: 'goal',
    nodes: [
      n('start', '起点', -3.8, 0, 'fixed'), n('entry', '镜廊入口', -2, 0, 'fixed'),
      n('a', '倒影入口', 2, 0, 'reflection'), n('seal', '镜中印记', 2, -2, 'reflection', true), n('b', '倒影出口', 1, -2, 'reflection'),
      n('exit', '镜廊外台', -2, 1, 'fixed'), n('goal', '终点', -3.8, 1, 'fixed'),
    ],
    edges: [['start', 'entry'], ['a', 'seal'], ['seal', 'b'], ['exit', 'goal']],
    hints: ['先走进蓝色倒影。镜中的印记和道路都是真正可以踩上的。', '拾取印记，走到倒影出口，再把镜子转到斜向。出口会来到另一座白色平台。'],
  },
  {
    id: 'fold', title: '折返', subtitle: '把远处，折到脚下', color: '#b69bc4',
    instruction: '沿中央折痕对折右半页。两处圆点重合就能跨过去；展开时，纸页会把人送回另一侧。',
    mechanics: ['fold'], start: 'start', goal: 'goal',
    nodes: [
      n('start', '起点', -3.7, 2.2, 'fixed'), n('entry', '左侧平台', -2.6, 2.2, 'fixed'),
      n('a', '左页入口', -2.6, 2.2, 'paper'), n('b', '左页转角', -2.6, .6, 'paper'), n('c', '折痕接点', -1, .6, 'paper'),
      n('d', '右页接点', 1, .6, 'wing'), n('seal', '右页印记', 1, -1.5, 'wing', true), n('e', '右页转角', 2.6, -1.5, 'wing'), n('f', '右页出口', 2.6, -2.2, 'wing'),
      n('exit', '门前平台', 2.6, -2.2, 'fixed'), n('goal', '终点', 3.7, -2.2, 'fixed'),
    ],
    edges: [['start', 'entry'], ['a', 'b'], ['b', 'c'], ['d', 'seal'], ['seal', 'e'], ['e', 'f'], ['exit', 'goal']],
    hints: ['折起右半页后，右页接点会和左页的圆点重合。点击重合处，或直接点击右页上的印记。', '让人站上右半页，再展开纸页。印记和出口都会随右半页回到右侧。'],
  },
  {
    id: 'hinge', title: '合页', subtitle: '转动、映照、对折', color: '#cba879',
    instruction: '先在左页找到镜中的印记，再借对折登上右页。最后转动整页，让出口与固定的拱门相接。',
    mechanics: ['turn', 'mirror', 'fold'], start: 'start', goal: 'goal',
    nodes: [
      n('start', '起点', -4.1, 0, 'fixed'), n('entry', '登页平台', -3.2, 0, 'fixed'),
      n('a', '纸页入口', 0, 3.2, 'paper'), n('b', '左页长廊', -3, 3.2, 'paper'), n('c', '镜前平台', -2, 0, 'paper'),
      n('r1', '倒影入口', 2, 0, 'reflection'), n('seal', '镜中印记', 2, -2, 'reflection', true), n('r2', '倒影出口', 1, -2, 'reflection'),
      n('d', '镜后平台', -2, 1, 'paper'), n('e', '左页折痕接点', -1, 1, 'paper'),
      n('f', '右页折痕接点', 1, 1, 'wing'), n('seal2', '右页印记', 2.4, 1, 'wing', true), n('g', '右页长廊', 2.4, -1.4, 'wing'), n('h', '右页出口', 3.6, .6, 'wing'),
      n('exit', '拱门平台', 3.6, .6, 'fixed'), n('goal', '终点', 4.5, .6, 'fixed'),
    ],
    edges: [['start', 'entry'], ['a', 'b'], ['b', 'c'], ['r1', 'seal'], ['seal', 'r2'], ['d', 'e'], ['f', 'seal2'], ['seal2', 'g'], ['g', 'h'], ['exit', 'goal']],
    hints: ['顺时针转页登上纸路，走到镜中。拾取镜中印记，再转动镜面，离开倒影。', '对折右半页，从左页接点走上右页，拾取第二枚印记。', '留在右页上展开，再逆时针转回整张纸。右页出口会接到右侧拱门。'],
  },
];

export function levelById(id: string): Level { return LEVELS.find((level) => level.id === id) ?? LEVELS[0]; }
