import { describe, expect, it } from 'vitest';
import { LOCAL_COMPONENT_NAMES } from 'reactive-md/authoring';
import {
  SITE_REACTIVE_COMPONENT_NAMES,
  SITE_REACTIVE_COMPONENT_SET,
} from '@/lib/reactive/component-names';

describe('component-names 快照与上游对账', () => {
  it('★ 上游组件名集合与本站快照完全一致（增删都会红）★', () => {
    expect([...SITE_REACTIVE_COMPONENT_NAMES].sort()).toEqual(
      [...LOCAL_COMPONENT_NAMES].sort()
    );
    expect(SITE_REACTIVE_COMPONENT_SET.size).toBe(SITE_REACTIVE_COMPONENT_NAMES.length);
  });
});
