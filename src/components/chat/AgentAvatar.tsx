/**
 * src/components/chat/AgentAvatar.tsx
 * 成员头像：可能是 emoji 也可能是 base64/URL 图片，按形态渲染。
 * 团队房间头部/气泡/花名册/确认卡共用。
 */
import { cn, isAvatarImage } from '@/lib/utils';

export function AgentAvatar({ avatar, className }: { avatar?: string | null; className?: string }) {
  if (isAvatarImage(avatar)) {
    return <img src={avatar!} alt="" className={cn('rounded-full object-cover', className)} />;
  }
  return <span className={className}>{avatar ?? '🤖'}</span>;
}
