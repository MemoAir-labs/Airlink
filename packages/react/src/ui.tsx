import * as Checkbox_ from "@radix-ui/react-checkbox";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { clsx } from "clsx";
import type { LucideIcon } from "lucide-react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  AtSign,
  Captions,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  FileUp,
  Globe,
  Hash,
  Headphones,
  Home,
  Laptop,
  LayoutGrid,
  Loader2,
  Maximize,
  MessageSquare,
  Mic,
  MicOff,
  Minus,
  Moon,
  MoreHorizontal,
  PenLine,
  Phone,
  PhoneOff,
  Plus,
  Presentation,
  RefreshCw,
  ScanFace,
  Search,
  Send,
  Settings,
  Sparkles,
  Sun,
  Table,
  Terminal,
  Trash2,
  UserPlus,
  Video,
  VideoOff,
  Volume2,
  VolumeX as VolumeOff,
  X,
} from "lucide-react";
import type {
  ButtonHTMLAttributes,
  ComponentType,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { twMerge } from "tailwind-merge";

// The live views' own small kit: Radix for behaviour, lucide for icons, and the semantic Tailwind
// tokens (`foreground`, `muted-background`, `border`, `highlight-*`, `warning-*`) that every
// host's stylesheet defines and redefines under `.dark`. Nothing here knows which host it runs in.

export const cn = (...inputs: Parameters<typeof clsx>) => twMerge(clsx(inputs));

export type IconComponent = ComponentType<{ className?: string }>;

export const DotsHorizontal: LucideIcon = MoreHorizontal;
export const Trash03: LucideIcon = Trash2;
export const XClose: LucideIcon = X;
export const RefreshCw02: LucideIcon = RefreshCw;
export const VolumeMax: LucideIcon = Volume2;
export const VolumeX: LucideIcon = VolumeOff;
export const MessageSquare01: LucideIcon = MessageSquare;
export const LinkExternal01: LucideIcon = ExternalLink;
export const ActionDocumentTextIcon: LucideIcon = FileText;
export const ActionFileIcon: LucideIcon = FileUp;
export const ActionGlobeIcon: LucideIcon = Globe;
export const ActionMarkPenIcon: LucideIcon = PenLine;
export const ActionSlideshowIcon: LucideIcon = Presentation;
export const ActionTableIcon: LucideIcon = Table;
export const ActionTerminalIcon: LucideIcon = Terminal;
export const Headphones01: LucideIcon = Headphones;
export const Laptop01: LucideIcon = Laptop;
export const LayoutGrid01: LucideIcon = LayoutGrid;
export const Hash02: LucideIcon = Hash;
export const Home02: LucideIcon = Home;
export const Moon01: LucideIcon = Moon;
export const Settings02: LucideIcon = Settings;
export const Phone01: LucideIcon = Phone;
export const Send01: LucideIcon = Send;
export {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  AtSign,
  Captions,
  Check,
  ChevronDown,
  Maximize,
  Mic,
  MicOff,
  Minus,
  PhoneOff,
  Plus,
  ScanFace,
  Search,
  Sparkles,
  Sun,
  UserPlus,
  Video,
  VideoOff,
};

const iconSizes = {
  xmini: "h-3 w-3",
  xs: "h-3.5 w-3.5",
  sm: "h-4 w-4",
  md: "h-5 w-5",
};

export function Icon({
  visual: Visual,
  size = "sm",
  className,
}: {
  visual: IconComponent;
  size?: keyof typeof iconSizes;
  className?: string;
}) {
  return <Visual className={cn("shrink-0", iconSizes[size], className)} />;
}

const spinnerSizes = { xs: "h-3.5 w-3.5", sm: "h-4 w-4", md: "h-6 w-6" };

export function Spinner({ size = "md" }: { size?: keyof typeof spinnerSizes }) {
  return (
    <Loader2
      role="status"
      aria-label="Loading"
      className={cn("animate-spin text-muted-foreground", spinnerSizes[size])}
    />
  );
}

const buttonVariants = {
  primary: "bg-highlight-500 text-white hover:bg-highlight-600",
  highlight: "bg-highlight-500 text-white hover:bg-highlight-600",
  outline:
    "border border-border bg-background text-foreground hover:bg-muted-background",
  ghost: "text-foreground hover:bg-muted-background",
  "ghost-secondary": "text-muted-foreground hover:bg-muted-background",
  warning: "bg-warning-600 text-white hover:bg-warning-700",
};

const buttonSizes = {
  xmini: "h-6 gap-1 rounded-md px-1.5 text-xs",
  xs: "h-7 gap-1 rounded-md px-2 text-xs",
  sm: "h-8 gap-1.5 rounded-lg px-3 text-sm",
};

interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  label?: string;
  icon?: IconComponent;
  size?: keyof typeof buttonSizes;
  variant?: keyof typeof buttonVariants;
  tooltip?: string;
  isLoading?: boolean;
  // A trigger for a menu: a chevron after the label.
  isSelect?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      label,
      icon: Visual,
      size = "sm",
      variant = "primary",
      tooltip,
      isLoading = false,
      isSelect = false,
      disabled,
      className,
      type = "button",
      ...rest
    },
    ref
  ) {
    return (
      <button
        ref={ref}
        type={type}
        title={tooltip}
        aria-label={label ? undefined : tooltip}
        disabled={disabled || isLoading}
        className={cn(
          "inline-flex shrink-0 select-none items-center justify-center font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlight-500 disabled:pointer-events-none disabled:opacity-50",
          buttonSizes[size],
          !label &&
            (size === "xmini"
              ? "w-6 px-0"
              : size === "xs"
                ? "w-7 px-0"
                : "w-8 px-0"),
          buttonVariants[variant],
          className
        )}
        {...rest}
      >
        {isLoading ? (
          <Loader2 className={cn("animate-spin", iconSizes[size])} />
        ) : (
          Visual && <Visual className={iconSizes[size]} />
        )}
        {label}
        {isSelect && <ChevronDown className={iconSizes[size]} />}
      </button>
    );
  }
);

const fieldClass =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-highlight-500 focus:outline-none";

export function Input({
  label,
  className,
  message,
  messageStatus = "error",
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  // A line under the field; red for an error.
  message?: string | null;
  messageStatus?: "error" | "info";
}) {
  const input = (
    <input
      className={cn(
        fieldClass,
        message && messageStatus === "error" && "border-warning-600",
        className
      )}
      aria-invalid={message && messageStatus === "error" ? true : undefined}
      {...rest}
    />
  );
  const field = message ? (
    <span className="flex flex-col gap-1">
      {input}
      <span
        className={cn(
          "text-xs font-normal",
          messageStatus === "error"
            ? "text-warning-600"
            : "text-muted-foreground"
        )}
      >
        {message}
      </span>
    </span>
  ) : (
    input
  );
  return label ? (
    <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
      {label}
      {field}
    </label>
  ) : (
    field
  );
}

export function TextArea({
  minRows,
  rows,
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number }) {
  return (
    <textarea
      className={cn(fieldClass, "resize-y", className)}
      rows={rows ?? minRows ?? 3}
      {...rest}
    />
  );
}

export function Checkbox({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Checkbox_.Root
      checked={checked}
      onCheckedChange={(value) => onCheckedChange(value === true)}
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border bg-background data-[state=checked]:border-highlight-500 data-[state=checked]:bg-highlight-500"
    >
      <Checkbox_.Indicator>
        <Check className="h-3 w-3 text-white" />
      </Checkbox_.Indicator>
    </Checkbox_.Root>
  );
}

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuSub = Menu.Sub;
export const DropdownMenuRadioGroup = Menu.RadioGroup;

const menuClass =
  "z-50 min-w-40 overflow-hidden rounded-lg border border-border bg-background p-1 text-sm text-foreground shadow-lg";
const itemClass =
  "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted-background";

export function DropdownMenuContent({
  align,
  children,
}: {
  align?: "start" | "center" | "end";
  children: ReactNode;
}) {
  return (
    <Menu.Portal>
      <Menu.Content align={align} sideOffset={4} className={menuClass}>
        {children}
      </Menu.Content>
    </Menu.Portal>
  );
}

export function DropdownMenuItem({
  label,
  icon: Visual,
  onClick,
  disabled,
}: {
  label: string;
  icon?: IconComponent;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <Menu.Item className={itemClass} onSelect={onClick} disabled={disabled}>
      {Visual && <Visual className="h-4 w-4" />}
      {label}
    </Menu.Item>
  );
}

export function DropdownMenuSeparator() {
  return <Menu.Separator className="my-1 h-px bg-border" />;
}

export function DropdownMenuSubTrigger({ label }: { label: string }) {
  return (
    <Menu.SubTrigger className={itemClass}>
      {label}
      <ChevronRight className="ml-auto h-4 w-4" />
    </Menu.SubTrigger>
  );
}

export function DropdownMenuSubContent({ children }: { children: ReactNode }) {
  return (
    <Menu.Portal>
      <Menu.SubContent sideOffset={4} className={menuClass}>
        {children}
      </Menu.SubContent>
    </Menu.Portal>
  );
}

export function DropdownMenuRadioItem({
  value,
  label,
  description,
}: {
  value: string;
  label: string;
  description?: string;
}) {
  return (
    <Menu.RadioItem
      value={value}
      className={cn(itemClass, "relative pl-7", description && "items-start")}
    >
      <Menu.ItemIndicator
        className={cn("absolute left-2", description && "top-2")}
      >
        <Check className="h-4 w-4" />
      </Menu.ItemIndicator>
      {description ? (
        <span className="flex max-w-64 flex-col gap-0.5">
          <span className="font-medium">{label}</span>
          <span className="text-xs text-muted-foreground">{description}</span>
        </span>
      ) : (
        label
      )}
    </Menu.RadioItem>
  );
}

export function DropdownMenuLabel({ label }: { label: string }) {
  return (
    <Menu.Label className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
      {label}
    </Menu.Label>
  );
}

export function Markdown({
  content,
  textColor = "text-foreground",
}: {
  content: string;
  textSize?: "sm" | "base";
  textColor?: string;
}) {
  return (
    <div
      className={cn(
        "text-sm leading-relaxed break-words [&_a]:text-highlight-600 [&_a]:underline [&_code]:rounded [&_code]:bg-muted-background [&_code]:px-1 [&_li]:ml-4 [&_ol]:list-decimal [&_p+p]:mt-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted-background [&_pre]:p-2 [&_ul]:list-disc",
        textColor
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

export type LiveNotification = {
  type: "success" | "error" | "info";
  title: string;
  description?: string;
};

type Notify = (notification: LiveNotification) => void;

const NotifyContext = createContext<Notify>(() => undefined);

export const useSendNotification = () => useContext(NotifyContext);

// A host with its own toasts passes `notify`; without it the area shows them itself.
function NotificationArea({
  children,
  notify,
}: {
  children: ReactNode;
  notify?: Notify;
}) {
  const [shown, setShown] = useState<(LiveNotification & { id: number })[]>([]);
  const show = useCallback((notification: LiveNotification) => {
    const id = Date.now() + Math.random();
    setShown((current) => [...current, { ...notification, id }]);
    setTimeout(
      () => setShown((current) => current.filter((item) => item.id !== id)),
      notification.type === "error" ? 8000 : 4000
    );
  }, []);
  const value = useMemo(() => notify ?? show, [notify, show]);
  return (
    <NotifyContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2"
      >
        {shown.map((item) => (
          <div
            key={item.id}
            role={item.type === "error" ? "alert" : "status"}
            className="pointer-events-auto rounded-lg border border-border bg-background p-3 text-sm shadow-lg"
          >
            <div
              className={cn(
                "font-medium",
                item.type === "error" ? "text-warning-600" : "text-foreground"
              )}
            >
              {item.title}
            </div>
            {item.description && (
              <div className="mt-1 text-muted-foreground">
                {item.description}
              </div>
            )}
          </div>
        ))}
      </div>
    </NotifyContext.Provider>
  );
}

export const Notification = { Area: NotificationArea };
