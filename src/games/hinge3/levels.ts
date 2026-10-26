import { IDENTITY, multiply, reflectionMatrix, type Crease, type Goal, type Level, type Mark, type Matrix } from './engine';

const vertical = (id: string, x: number): Crease => ({ id, name: `${id} · 竖折`, nx: 1, ny: 0, c: x, side: -1 });
const horizontal = (id: string, y: number): Crease => ({ id, name: `${id} · 横折`, nx: 0, ny: 1, c: y, side: 1 });
const diagonal: Crease = { id: 'C', name: 'C · 斜折', nx: -1, ny: 1, c: 0, side: 1 };
const X = reflectionMatrix(vertical('A', 4)), Y = reflectionMatrix(horizontal('B', 4)), D = reflectionMatrix(diagonal);
const ink = (x: number, y: number, face: 'front' | 'back' = 'front'): Mark => ({ x, y, face, color: face === 'front' ? 'red' : 'blue', matrix: IDENTITY, wet: true });
const goal = (x: number, y: number, matrix: Matrix, face: 'front' | 'back' = 'front'): Goal => ({ x, y, matrix, face, color: face === 'front' ? 'red' : 'blue' });

export const LEVELS: readonly Level[] = [
  {
    id: 'first', title: '第一道印', rule: '把红色湿墨印进虚线框。折起后压一下，再展开看看方向。',
    creases: [vertical('A', 4)], holes: [], ink: [ink(2, 4)], goals: [goal(6, 4, X)],
    hints: ['原来的墨在左侧，虚线框在右侧。它们到折痕的距离相同。', '沿 A 折起，压印，再展开。印痕的左右方向会颠倒。'],
  },
  {
    id: 'twice', title: '再反一次', rule: '目标印记和原稿朝向相同。新印痕也带着湿墨，可以继续转印。',
    creases: [vertical('A', 2), vertical('B', 4)], holes: [], ink: [ink(1, 3)], goals: [goal(5, 3, IDENTITY)],
    hints: ['一次转印会把方向翻反。两次沿平行折痕转印，会恢复原来的朝向。', '先沿 A 折起、压印、展开；再对 B 做同样的操作。'],
  },
  {
    id: 'window', title: '纸上的空处', rule: '洞里没有纸，接不到墨。两条折痕都能用，但压印顺序会改变结果。',
    creases: [vertical('A', 3), horizontal('B', 4)], holes: [{ x: 5, y: 2, width: 1.2, height: 1.2 }],
    ink: [ink(1, 2)], goals: [goal(5, 6, multiply(X, Y))],
    hints: ['先竖折时，墨会正好落进镂空处；没有接触到纸，墨就不会转印。', '先沿 B 横折，把墨印到左下。展开后，再沿 A 竖折。'],
  },
  {
    id: 'reverse', title: '另一面', rule: '这张纸的目标在背面。折起时露出的背面，和内部正在接触的纸面，是两回事。',
    creases: [vertical('A', 4)], holes: [{ x: 4, y: 1.5, width: 1.2, height: 1.2 }],
    ink: [ink(2, 4), ink(2, 4, 'back')], goals: [goal(6, 4, X, 'back')],
    hints: ['正面的红墨不会穿透纸张。先翻面，找到背面的蓝墨和目标框。', '在背面沿 A 折起，压印、展开。背面的印痕始终留在背面。'],
  },
  {
    id: 'register', title: '双面套印', rule: '让正反两面的印记各自对准校样。斜折也会产生镜像；留意纸上的镂空。',
    creases: [vertical('A', 3), horizontal('B', 4), diagonal], holes: [{ x: 5, y: 2, width: 1.2, height: 1.2 }],
    ink: [ink(1, 2), ink(2, 1, 'back')], goals: [goal(5, 6, multiply(X, Y)), goal(5, 6, multiply(multiply(X, Y), D), 'back')],
    hints: ['正面的红印可以用「纸上的空处」那一页的方法完成。', '背面蓝墨的出发位置和方向不同。先斜折 C，会把它带到熟悉的位置。', '正面依次压印 B、A；翻面后依次压印 C、B、A。每次压印后都先展开。'],
  },
];
export const levelById = (id: string): Level => LEVELS.find((level) => level.id === id) ?? LEVELS[0];
