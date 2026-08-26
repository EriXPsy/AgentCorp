/**
 * TeamRadar — 六维雷达图组件
 *
 * 显示团队及其成员在六个维度上的能力分布。
 * 数据源：fetchTeamRadar（移动平均，不实时跳动）。
 */
import { useMemo } from 'react';
import type { TeamRadarResponse } from '@/types/designer';

const DIM_LABELS: Record<string, string> = {
  code_runnability: '可运行',
  code_efficiency: '效率',
  code_maintainability: '可维护',
  code_security: '安全',
  task_completion: '完成度',
  communication: '沟通',
  creativity: '创造力',
  cost: '成本',
};

const AGENT_COLORS = [
  '#FFD233', '#FF6B4A', '#4A90D9', '#7B61FF', '#2ECC71', '#E74C3C',
];

function polarToCartesian(cx: number, cy: number, r: number, angle: number) {
  const rad = (angle - 90) * (Math.PI / 180);
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function polygonPoints(cx: number, cy: number, r: number, sides: number): string {
  return Array.from({ length: sides }, (_, i) => {
    const angle = (360 / sides) * i;
    const { x, y } = polarToCartesian(cx, cy, r, angle);
    return `${x},${y}`;
  }).join(' ');
}

export function TeamRadar({ data }: { data: TeamRadarResponse }) {
  const { dimensions, team_scores, agent_scores, team_size } = data;

  const size = 280;
  const cx = size / 2;
  const cy = size / 2;
  const maxR = 100;
  const sides = dimensions.length;

  // 网格线
  const gridLevels = [0.2, 0.4, 0.6, 0.8, 1.0];

  const agentEntries = useMemo(
    () => Object.entries(agent_scores),
    [agent_scores],
  );

  return (
    <div className="flex flex-col items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* 网格 */}
        {gridLevels.map((level) => (
          <polygon
            key={level}
            points={polygonPoints(cx, cy, maxR * level, sides)}
            fill="none"
            stroke="#E5E5E5"
            strokeWidth={1}
          />
        ))}

        {/* 轴线 + 标签 */}
        {dimensions.map((dim, i) => {
          const angle = (360 / sides) * i;
          const { x, y } = polarToCartesian(cx, cy, maxR, angle);
          const labelPos = polarToCartesian(cx, cy, maxR + 20, angle);
          return (
            <g key={dim}>
              <line x1={cx} y1={cy} x2={x} y2={y} stroke="#E5E5E5" strokeWidth={1} />
              <text
                x={labelPos.x}
                y={labelPos.y}
                textAnchor="middle"
                dominantBaseline="middle"
                className="text-[9px] fill-gray-500 font-bold"
              >
                {DIM_LABELS[dim] ?? dim}
              </text>
            </g>
          );
        })}

        {/* 团队均值面 */}
        <polygon
          points={dimensions.map((dim, i) => {
            const val = (team_scores[dim] ?? 0) / 5;
            const angle = (360 / sides) * i;
            const { x, y } = polarToCartesian(cx, cy, maxR * Math.min(val, 1), angle);
            return `${x},${y}`;
          }).join(' ')}
          fill="rgba(255, 210, 51, 0.15)"
          stroke="#FFD233"
          strokeWidth={2}
        />

        {/* 各 agent 面 */}
        {agentEntries.map(([agentId, scores], idx) => {
          const color = AGENT_COLORS[idx % AGENT_COLORS.length];
          return (
            <polygon
              key={agentId}
              points={dimensions.map((dim, i) => {
                const val = (scores[dim] ?? 0) / 5;
                const angle = (360 / sides) * i;
                const { x, y } = polarToCartesian(cx, cy, maxR * Math.min(val, 1), angle);
                return `${x},${y}`;
              }).join(' ')}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              strokeDasharray="4 2"
              opacity={0.7}
            />
          );
        })}
      </svg>

      {/* 图例 */}
      <div className="flex flex-wrap gap-3">
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#FFD233]" />
          <span className="text-[10px] font-bold text-gray-600">团队均值</span>
        </div>
        {agentEntries.map(([agentId], idx) => (
          <div key={agentId} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: AGENT_COLORS[idx % AGENT_COLORS.length] }}
            />
            <span className="text-[10px] font-bold text-gray-600">
              {agentId.slice(0, 8)}
            </span>
          </div>
        ))}
      </div>

      {team_size > 0 && (
        <p className="text-[10px] text-gray-400">
          最近 10 次移动平均 · {team_size} 名成员
        </p>
      )}
    </div>
  );
}
