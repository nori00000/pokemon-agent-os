import type { StateTransition } from "../session/transition-detector";

export interface RewardBreakdown {
  components: {
    anti_loop_penalty: number;
    anti_spam_penalty: number;
    battle_reward: number;
    event_reward: number;
    mission_reward: number;
    navigation_reward: number;
    recovery_reward: number;
    strategic_reward: number;
  };
  reward_total: number;
}

export function calculateTransitionReward(
  transition: StateTransition,
  repeatedNoneTransitions = 0
): RewardBreakdown {
  const components = {
    anti_loop_penalty: transition.kind === "none" ? -0.1 * Math.max(1, repeatedNoneTransitions) : 0,
    anti_spam_penalty: 0,
    battle_reward: 0,
    event_reward: transition.kind === "mode" ? 0.2 : 0,
    mission_reward: transition.kind === "map" ? 1.5 : 0,
    navigation_reward: transition.kind === "movement" ? 0.4 : 0,
    recovery_reward: 0,
    strategic_reward: 0,
  };
  return {
    components,
    reward_total: Object.values(components).reduce((sum, value) => sum + value, 0),
  };
}
