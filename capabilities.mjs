const profiles = [
  {
    id: 'general',
    label: '综合分析',
    description: '根据问题选择分析角度，给出理由和建议。',
    prompt: '',
  },
  {
    id: 'verify',
    label: '事实核查',
    description: '核对影响结论的事实和数字，标出仍待验证的说法。',
    prompt: '优先核查足以改变结论的事实、数字和引述，说明每项判断依据。只有本轮实际查阅过的资料才可标为已查证。无法查证时标为待核实，并给出具体的核实途径。',
  },
  {
    id: 'risk',
    label: '风险审查',
    description: '识别主要风险、预警信号和应对办法。',
    prompt: '挑出最可能使方案失效或造成重大损失的假设。按影响和发生条件排出优先级，说明如何尽早发现风险，以及可行的缓解措施。概率缺乏依据时采用定性判断。',
  },
  {
    id: 'plan',
    label: '方案规划',
    description: '把目标拆成可执行的步骤，列出依赖和验收条件。',
    prompt: '围绕用户目标提出可执行的步骤，说明先后依赖、需要的资源和完成标准。指出应首先采取的行动，以及遇到关键阻碍时如何调整计划。',
  },
  {
    id: 'compare',
    label: '方案比较',
    description: '按同一组标准比较可行选项，解释取舍和适用条件。',
    prompt: '根据用户目标和限制确定比较标准，逐项对照可行选项。说明主要取舍、证据缺口和哪些条件会改变排序。用户偏好尚未确定时给出有条件的选择。',
  },
];

export const CAPABILITIES = profiles.map(({ id, label, description }) => ({ id, label, description }));

export function capabilityPrompt(id = 'general') {
  return profiles.find(profile => profile.id === id)?.prompt ?? '';
}
