/**
 * 并发闸门。
 *
 * 采集站的容忍度很低：一次分类浏览本来就要打「源数 × 子分类数」个请求，
 * 4 个源 × 6 个子分类 = 24 个并发；启动预热再叠上来就是几十个同时出去，
 * 上游会直接 503 / 断开，表现就是「所有源都失败、这个分类一部片子都没有」。
 *
 * 这里给分类相关的请求加一个全局闸门，把并发压回个位数。
 */
export interface Limiter {
  <T>(task: () => Promise<T>): Promise<T>;
  /** 当前排队 + 执行中的任务数（调试与测试用） */
  readonly size: number;
}

export function createLimiter(concurrency: number): Limiter {
  const max = Math.max(1, Math.floor(concurrency));
  let running = 0;
  let waiting = 0;
  const queue: Array<() => void> = [];

  const run = <T>(task: () => Promise<T>): Promise<T> => {
    waiting++;
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        waiting--;
        running++;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            running--;
            const next = queue.shift();
            if (next) next();
          });
      };
      if (running < max) start();
      else queue.push(start);
    });
  };

  // 注意不能用 Object.assign：它在赋值的那一刻就把 getter 求值了，
  // `size` 会被固化成 0（这个坑被 limiter.test.ts 抓到了）。
  Object.defineProperty(run, 'size', {
    get: () => running + waiting,
    enumerable: true,
  });

  return run as Limiter;
}

/**
 * 分类浏览 / 分类表用的共享闸门。
 *
 * 定在 6：单源自己最多同时开 2~3 个请求（子分类并行），两三个源一起跑刚好，
 * 再高就容易触发上游限流。
 */
export const catalogLimiter = createLimiter(6);

const sourceLimiters = new Map<string, Limiter>();

/**
 * 单个源自己的闸门：一个源内部的子分类请求不要扎堆。
 *
 * 按源地址分配，所以源之间仍然可以并行；同为 3 是因为实测单个采集站
 * 同时超过 3 个请求就开始 503。
 */
export function sourceLimiter(key: string): Limiter {
  let limiter = sourceLimiters.get(key);
  if (!limiter) {
    limiter = createLimiter(3);
    sourceLimiters.set(key, limiter);
  }
  return limiter;
}
