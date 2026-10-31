/**
 * 挑战卡 / 专家卡 / 难度模式。
 *
 * 文案照官方手册翻译；`effects()` 把「这一局激活了哪几张挑战卡」翻译成
 * 一组布尔开关，规则引擎只认这些开关，不散落 if（challenge === 3) 这种判断。
 */

export type GangMode = 'basic' | 'advanced' | 'professional' | 'master';

export interface CardInfo {
  name: string;
  text: string;
}

export const CHALLENGE: Record<number, CardInfo> = {
  1: {
    name: '快速通道',
    text: '这次抢劫不发白色筹码：直接翻 3 张公共牌，从翻牌轮开始。',
  },
  2: {
    name: '噪音感应器',
    text: '前三轮的 1 星筹码一旦被拿走就锁死，不能再被抢走。',
  },
  3: {
    name: '动作感应器',
    text: '如果翻牌轮翻出的 3 张里有 J/Q/K：拿白色 1 星的人把底牌丢掉重抽两张。',
  },
  4: {
    name: '视网膜扫描',
    text: '摊牌前，除红筹码最高的人之外，其他人要统一猜「他手里至少有一张什么点数」，猜错这次抢劫失败。',
  },
  5: {
    name: '匆忙撤离',
    text: '第三轮不发橙色筹码：翻完第 4 张公共牌直接进河牌轮。',
  },
  6: {
    name: '通风管道',
    text: '前三轮的最高星筹码一旦被拿走就锁死，不能再被抢走。',
  },
  7: {
    name: '激光绊网',
    text: '如果翻牌轮的 3 张里没有 J/Q/K：拿白色最高星的人把底牌丢掉重抽两张。',
  },
  8: {
    name: '断电',
    text: '第 2、3、4 轮开始时，把上一轮的筹码全部丢掉——只能靠记性。',
  },
  9: {
    name: '指纹扫描',
    text: '摊牌前，除红筹码最高的人之外，其他人要统一猜「他是哪种牌型」，猜错这次抢劫失败。',
  },
  10: {
    name: '安全摄像头',
    text: '每人发 3 张底牌，从 8 张里选最优的 5 张。',
  },
};

export const SPECIALIST: Record<number, CardInfo> = {
  1: { name: '线人', text: '你们决定一个人，他可以把自己的一张底牌偷偷给另一个人看。' },
  2: { name: '老司机', text: '你们决定一个人，他公布自己现在这手牌是什么牌型。' },
  3: { name: '投资人', text: '发完底牌，每个人说自己手里有几张人头牌（J/Q/K）。' },
  4: { name: '主谋', text: '你们定一个点数，然后一个人说出自己手里有几张这个点数。' },
  5: { name: '黑客', text: '你们决定一个人，他多抽一张底牌，然后弃掉一张。' },
  6: { name: '协调者', text: '发完底牌，每个人同时把一张底牌传给左手边的人。' },
  7: { name: '老千 J', text: '你们决定一个人，他多一张「J」万能牌（算 J、没有花色），然后弃掉一张牌。' },
  8: { name: '数学老师', text: '发完底牌，每个人公布自己底牌点数之和（J/Q/K 算 10，A 算 11）。' },
  9: { name: '女骗子', text: '发完底牌、大家都看过之后，把底牌全部混在一起重新发。' },
  10: { name: '打手', text: '你们决定一个人：摊牌时，他的牌型跟别人相同时算他大。' },
};

/** 挑战卡翻译成引擎开关；规则逻辑只看这些布尔值 */
export interface ChallengeEffects {
  /** 快速通道：跳过第一轮 */
  skipFirst: boolean;
  /** 匆忙撤离：跳过第三轮 */
  skipThird: boolean;
  /** 噪音感应器：前三轮 1 星锁死 */
  lockLow: boolean;
  /** 通风管道：前三轮最高星锁死 */
  lockHigh: boolean;
  /** 断电：每轮开始清掉上一轮筹码 */
  blackout: boolean;
  /** 安全摄像头：每人 3 张底牌 */
  pocketSize: number;
  /** 动作感应器 / 激光绊网：翻牌轮触发换底牌 */
  redraw: 'face' | 'noFace' | null;
  /** 视网膜 / 指纹扫描：摊牌前全队先猜 */
  guess: 'value' | 'rank' | null;
}

export function effectsOf(challenge: readonly number[]): ChallengeEffects {
  const has = (id: number) => challenge.includes(id);
  return {
    skipFirst: has(1),
    skipThird: has(5),
    lockLow: has(2),
    lockHigh: has(6),
    blackout: has(8),
    pocketSize: has(10) ? 3 : 2,
    redraw: has(3) ? 'face' : has(7) ? 'noFace' : null,
    guess: has(4) ? 'value' : has(9) ? 'rank' : null,
  };
}

export const MODE_NAME: Record<GangMode, string> = {
  basic: '基础局',
  advanced: '进阶',
  professional: '专业',
  master: '大师',
};
