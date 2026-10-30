import { useState } from "react";
import { Bell } from "lucide-react";
import { Card, Switch } from "./ui";
import { unlockChime } from "../lib/ui/chime";
import { usePreferences } from "../store/preferences";
import { canWakeWhileClosed, startWakingWhileClosed, stopWakingWhileClosed, wakesWhileClosed } from "../lib/network/push";
import { describeError } from "../lib/ui/errors";
import { useT } from "../i18n";

const supported = typeof Notification !== "undefined";

/// This device's notification settings: order updates as system
/// notifications, being woken for them while the app is closed (when the
/// network runs a push relay), and -- on a device running a store -- a
/// chime for each new order.
export function NotificationSettings({ runsStore }: { runsStore: boolean }) {
  const t = useT();
  const { notifications, newOrderChime, setNotifications, setNewOrderChime } = usePreferences();
  const [permission, setPermission] = useState(() => (supported ? Notification.permission : "denied"));

  const [wakes, setWakes] = useState(wakesWhileClosed);
  const [wakeError, setWakeError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  async function toggleWakes(on: boolean) {
    setSwitching(true);
    setWakeError(null);
    try {
      if (on) await startWakingWhileClosed();
      else await stopWakingWhileClosed();
    } catch (err) {
      setWakeError(describeError(err));
    } finally {
      setWakes(wakesWhileClosed());
      setSwitching(false);
    }
  }

  async function toggleNotifications(on: boolean) {
    if (!on) return setNotifications(false);
    const granted = permission === "granted" ? "granted" : await Notification.requestPermission();
    setPermission(granted);
    setNotifications(granted === "granted");
  }

  return (
    <Card className="mb-4 flex flex-col gap-3 p-4">
      <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-ink-400">
        <Bell size={12} /> {t("notifications.title")}
      </p>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{t("notifications.orders")}</p>
          <p className="text-xs text-ink-400">
            {!supported ? t("notifications.unsupported") : permission === "denied" ? t("notifications.blocked") : t("notifications.ordersDetail")}
          </p>
        </div>
        <Switch checked={notifications && permission === "granted"} onChange={toggleNotifications} disabled={!supported || permission === "denied"} label={t("notifications.ordersLabel")} />
      </div>
      {canWakeWhileClosed() && (
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{t("notifications.closed")}</p>
            <p className={wakeError ? "text-xs text-red-600 dark:text-red-400" : "text-xs text-ink-400"}>{wakeError ?? t("notifications.closedDetail")}</p>
          </div>
          <Switch checked={wakes} onChange={toggleWakes} disabled={switching} label={t("notifications.closedLabel")} />
        </div>
      )}
      {runsStore && (
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{t("notifications.chime")}</p>
            <p className="text-xs text-ink-400">{t("notifications.chimeDetail")}</p>
          </div>
          <Switch
            checked={newOrderChime}
            onChange={(on) => {
              // Turning it on is the tap that lets the page play sound.
              if (on) unlockChime();
              setNewOrderChime(on);
            }}
            label={t("notifications.chime")}
          />
        </div>
      )}
    </Card>
  );
}
