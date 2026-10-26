import type { Color, Direction, Level, Port } from './engine';

export const CHAPTERS = [
  { title: '放下与留空', concept: '先学会决定在哪里转弯' },
  { title: '两束光，一盘镜', concept: '一个选择，同时改变两条路线' },
  { title: '相互牵制', concept: '从两个出口一起倒推' },
] as const;

/** Ports sit just outside the board. N/S use column numbers, W/E row numbers.
 * All levels start empty; the notation records sockets, never the solution. */
export function makeLevel(id: string, title: string, chapter: number, stock: number, rows: string[], sourceNames: string[], targetNames: string[], intro: string, hints: readonly string[], insight: string): Level {
  const size = rows.length;
  if (rows.some((r) => r.length !== size || /[^o.]/.test(r))) throw new Error(`${id}: invalid board`);
  function port(name: string, i: number): Port {
    const side = name[0], n = Number(name.slice(1)) - 1;
    if (!'NESW'.includes(side) || n < 0 || n >= size) throw new Error(`${id}: invalid port`);
    return { x: side === 'W' ? -1 : side === 'E' ? size : n,
      y: side === 'N' ? -1 : side === 'S' ? size : n,
      direction: ({ N: 2, E: 3, S: 0, W: 1 }[side] ?? 0) as Direction,
      color: (i === 0 ? 'gold' : 'blue') as Color };
  }
  return { id, title, chapter, stock, size, intro, hints, insight,
    sockets: rows.flatMap((r, y) => [...r].flatMap((c, x) => c === 'o' ? [{ x, y }] : [])),
    sources: sourceNames.map(port), targets: targetNames.map(port) };
}

// The verifier checks every layout within the stock, including unused mirrors:
// each puzzle has exactly one solution and none can use fewer mirrors. From 04
// onward, both beams must use a common mirror; independent routes do not fit.
export const LEVELS: Level[] = [
  makeLevel('01', '直角', 0, 1, ['..o..', '.....', '.oo..', '.....', '.....'], ['W3'], ['N3'],
    '把一面镜片放在安装点上，让金光进入金色圆环。',
    ['光在空安装点上会直行，只有放上镜片才会转弯。', '从上方圆环向下看，再从光源向右看，两条直线在哪里相交？', '在 C3 放 / 镜片：向右的光会转向上。'],
    '出口和入口各画一条直线，交点就是唯一需要转弯的位置。'),
  makeLevel('02', '两次转弯', 0, 2, ['.o.o.', '.o...', '...o.', '.o.o.', '.....'], ['W4'], ['E2'],
    '只有两面镜片。先想清楚光怎样进入右侧的圆环。',
    ['从出口倒着追光，与从光源出发一样有效。', '最后一次转弯必须发生在第 2 行。那一行只有一个安装点。', '先确定 B2，再沿 B 列往下找到 B4；其他安装点留空。'],
    '从出口倒推会先确定最后一面镜片，整条路线随后被限定。'),
  makeLevel('03', '留空也是选择', 0, 3, ['.o.o.', '....o', 'oo..o', '...o.', '.....'], ['W3'], ['N4'],
    '不必填满安装点。让光穿过该留空的地方，再转弯。',
    ['离光源最近的安装点，未必适合放镜片。', 'A 列没有第二个安装点，过早转弯会直接出界。', 'A3 留空。路线经过 B3、B1、D1；注意三次反射的方向。'],
    '安装点只是可能性。留空才能把光送到真正有用的转弯处。'),
  makeLevel('04', '一镜两用', 0, 3, ['oo...', '..oo.', '..o..', '...o.', '.....'], ['E4', 'S3'], ['E2', 'N4'],
    '两束光都要到达同色圆环。它们共用三面镜片。',
    ['分别为两束光安排两面镜片，会超过库存。', '同一面镜片可以从两侧接住两束光，并把它们送往不同方向。', 'D2 是共用的位置。金光从下方到达，蓝光从左侧到达。'],
    'D2 的一面镜片同时完成两次反射，四次转弯只用了三面镜。'),
  makeLevel('05', '不能各走各的', 1, 4, ['..o..', '.....', '.oo.o', 'oo...', '..o..'], ['W3', 'E1'], ['E4', 'N2'],
    '给一束光找到的好路线，必须也给另一束光留下位置。',
    ['先别急着把金光送到最近的安装点，看看蓝光要怎样离开第 1 行。', '通向蓝色出口的最后一面镜片，也要接住金光。', 'B3 共用。金光从这里向下，蓝光从右边到达这里后向上。'],
    'B3 既是金光的起点转弯，也是蓝光的最后一次转弯。'),
  makeLevel('06', '正前方的错觉', 1, 4, ['..o..', 'o.o.o', 'o...o', '....o', '..o..'], ['E3', 'S3'], ['N3', 'N1'],
    '蓝光正对着一个圆环。先辨认它该去的出口。',
    ['亮着的光路不一定正确：蓝光不能进入金色圆环。', '金光必须借道 C 列，蓝光却要从 C 列转到 A 列。', 'C2 的反射镜由两束光共用；C1 必须留空，让金光直达上方。'],
    '蓝光让出正前方的出口，C2 的同一次摆放同时替两束光转弯。'),
  makeLevel('07', '出口的约束', 1, 5, ['..oo.', '.o.o.', '...o.', 'oo...', 'o..o.'], ['E3', 'N1'], ['N2', 'W2'],
    '从两个出口同时倒推，寻找路线必须相遇的地方。',
    ['左侧蓝色出口需要横向来光，上方金色出口需要纵向来光。', '蓝光从 A 列向下走，必须在到达边界之前转向 B 列。', '共用镜片在 B2。两条路线各转三次弯，但五面镜片就够。'],
    '先确定两个出口需要的方向，B2 就成为两条路线共同的转弯处。'),
  makeLevel('08', '空位串起的路', 1, 5, ['..o.o.', '...o..', '.o.oo.', 'o.oo..', '..o...', 'o...o.'], ['N4', 'E1'], ['W5', 'S1'],
    '这次安装点更多，镜片仍只有五面。先排除会让光过早转弯的位置。',
    ['光源附近的安装点很多，但从出口倒推时，选择会少得多。', '两束光都需要经过第 4 行；共用的转弯处不在边缘。', 'C4 共用。D2、D3 留空，金光要一直走到 D4 才转弯。'],
    '空位把分散的镜片连起来。少放一面，比多转一次更关键。'),
  makeLevel('09', '连锁反应', 2, 6, ['oo..o', '..o.o', '..ooo', 'oo...', '...o.'], ['E2', 'W1'], ['N4', 'E5'],
    '六面镜片同时照顾两条路线。改动中间一处，就会牵动两端。',
    ['先看右下方的蓝色出口：哪一面镜片能把光横向送过去？', '蓝光必须从 D5 出发向右，金光最后沿 D 列向上。', 'D3 是共用镜片；蓝光由右而来向下走，金光由左而来向上走。'],
    'D3 把来自左右的两束光分别送往上下，两个出口因此被一起满足。'),
  makeLevel('10', '暂时熄灭', 2, 6, ['..o...', '.o....', '.....o', '.o.o..', '.ooooo', '.....o'], ['E5', 'S2'], ['W5', 'W1'],
    '金色圆环已经亮了。但要同时完成两条路线，可能得先打断它。',
    ['已点亮的圆环不需要一直保持亮着。撤销和试验都没有惩罚。', '蓝光必须经过 B5。这里放上镜片后，金光就不能再沿第 5 行直走。', '先让金光经 D5、D4、B4 绕回来，再由共用的 B5 送入原来的出口。'],
    '局部完成会妨碍整体完成。先熄灭金环，再绕回它，才给蓝光腾出了路。'),
  makeLevel('11', '远路的理由', 2, 7, ['...o...', '.......', 'o.o...o', '...o.o.', 'o.oo.oo', 'o...oo.', '.......'], ['N7', 'E1'], ['S5', 'E3'],
    '两个出口看起来都不远，七面镜片却各有用途。',
    ['先看 E 列下方的金色出口：沿途没有安装点，最后一次反射只能更早发生。', '金光要经 E6 向下，它必须先到达棋盘左侧，再沿第 6 行回来。', 'G3 由两束光共用。金光向左绕行，蓝光从下方到达后向右出界。'],
    '出口决定了最后一段直线，而最后一段又反过来决定整条远路。'),
  makeLevel('12', '同一盘棋', 2, 8, ['..o..o.', 'o......', '.....o.', '....oo.', 'o.o..o.', 'o.o....', '.o...oo'], ['S2', 'W5'], ['E6', 'W4'],
    '八面镜片，两个出口。把前面学会的留空、倒推与共用放到一起。',
    ['分别接好一条路还不够。寻找两条路线都无法绕开的那一面镜片。', '金光要从 C6 向右进入出口；蓝光要从 F4 向左进入出口。', 'C5 共用。金光从右侧到这里后向下，蓝光从左侧到这里后向上；F3 留空。'],
    'C5 是整盘棋的交点。八面镜片承担九次反射，空位则把所有转弯接成两条完整路线。'),
];
