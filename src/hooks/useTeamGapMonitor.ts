/**
 * useTeamGapMonitor — 轮询团队缺口分析，检测到 high urgency 时弹 Toast 通知用户
 *
 * 使用方式：在 MainLayout 中 mount，传入当前活跃团队列表。
 * 轮询间隔 60s，首次挂载时立即检查一次。
 * 每个缺口 key（team_id + urgency 组合）只通知一次。
 */
import { useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';
import { useDesignerStore } from '@/stores/designerStore';

const POLL_INTERVAL = 60_000;

export function useTeamGapMonitor(teamIds: string[]) {
  const navigate = useNavigate();
  const fetchTeamGaps = useDesignerStore((s) => s.fetchTeamGaps);
  const notifiedGapKeys = useDesignerStore((s) => s.notifiedGapKeys);
  const markGapNotified = useDesignerStore((s) => s.markGapNotified);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const teamIdsKey = useMemo(() => teamIds.filter(Boolean).join(','), [teamIds]);
  const targetTeamIds = useMemo(() => (teamIdsKey ? teamIdsKey.split(',') : []), [teamIdsKey]);

  useEffect(() => {
    if (targetTeamIds.length === 0) return;

    const checkGaps = async () => {
      for (const teamId of targetTeamIds) {
        try {
          const gaps = await fetchTeamGaps(teamId);
          if (!gaps || gaps.hiring_urgency === 'low') continue;

          const gapKey = `${teamId}:${gaps.hiring_urgency}`;
          if (notifiedGapKeys.includes(gapKey)) continue;

          // 标记已通知（避免重复弹）
          markGapNotified(gapKey);

          toast.warning(
            `🤖 团队「${gaps.team_id}」需要补人`,
            {
              description: gaps.hiring_reason,
              duration: 10_000,
              action: {
                label: '去市集看看',
                onClick: () => navigate('/marketplace'),
              },
            },
          );
        } catch {
          // 单个团队检测失败不影响其他团队
        }
      }
    };

    void checkGaps();
    timerRef.current = setInterval(() => void checkGaps(), POLL_INTERVAL);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [teamIdsKey, targetTeamIds, fetchTeamGaps, notifiedGapKeys, markGapNotified, navigate]);
}
