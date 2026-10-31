import { z } from "zod";

import { Alert } from "./components/alert";
import { AlertDialogBlock } from "./components/alert-dialog-block";
import { ShadcnBadgeComponent } from "./components/badge";
import { CalendarBlock } from "./components/calendar-block";
import { CodeBlock } from "./components/code-block";
import { DialogBlock } from "./components/dialog-block";
import { DrawerBlock } from "./components/drawer-block";
import { FollowUpBlock } from "./components/follow-up-block";
import { Image, ImageBlock } from "./components/image";
import { MarkDownRenderer } from "./components/markdown-renderer";
import { PaginationBlock } from "./components/pagination-block";
import { Progress } from "./components/progress";
import { Separator } from "./components/separator";
import { TextContent } from "./components/text-content";
import { Blockquote, Heading, InlineCode } from "./components/typography";

import { Table } from "./components/table";
import { TagBlock } from "./components/tag";

import { Avatar } from "./components/avatar";
import { Buttons } from "./components/buttons";
import { CardHeader } from "./components/card-header";
import { Form } from "./components/form";
import {
  CollapsibleBlock,
  Combobox,
  CommandBlock,
  CommandDialogBlock,
  DropdownMenuBlock,
  HoverCardBlock,
  NativeSelect,
  PopoverBlock,
  TooltipBlock,
} from "./groups/selection";
import {
  ButtonGroupBlock,
  EmptyBlock,
  InputGroup,
  ItemBlock,
  Kbd,
  OtpInput,
  SkeletonBlock,
  SpinnerBlock,
  ToastBlock,
  ToggleBlock,
  ToggleGroupBlock,
} from "./groups/feedback";
import {
  AttachmentBlock,
  BubbleBlock,
  MarkerBlock,
  MessageBlock,
  MessageScrollerBlock,
  QuestionnaireBlock,
} from "./groups/chat";
import {
  AspectRatioBlock,
  BreadcrumbBlock,
  ContextMenuBlock,
  MenubarBlock,
  NavigationMenuBlock,
  ResizableBlock,
  ScrollAreaBlock,
  SheetBlock,
  SidebarBlock,
} from "./groups/layout";

export const ContentChildUnion = z.union([
  TextContent.ref,
  MarkDownRenderer.ref,
  CardHeader.ref,
  Alert.ref,
  ShadcnBadgeComponent.ref,
  Avatar.ref,
  CodeBlock.ref,
  Image.ref,
  ImageBlock.ref,
  Progress.ref,
  Separator.ref,
  Table.ref,
  TagBlock.ref,
  Form.ref,
  Buttons.ref,
  Heading.ref,
  Blockquote.ref,
  InlineCode.ref,
  PaginationBlock.ref,
  DialogBlock.ref,
  AlertDialogBlock.ref,
  DrawerBlock.ref,
  CalendarBlock.ref,
  CommandBlock.ref,
  CommandDialogBlock.ref,
  Combobox.ref,
  NativeSelect.ref,
  PopoverBlock.ref,
  DropdownMenuBlock.ref,
  TooltipBlock.ref,
  HoverCardBlock.ref,
  CollapsibleBlock.ref,
  SkeletonBlock.ref,
  SpinnerBlock.ref,
  ToggleBlock.ref,
  ToggleGroupBlock.ref,
  OtpInput.ref,
  Kbd.ref,
  EmptyBlock.ref,
  ItemBlock.ref,
  InputGroup.ref,
  ButtonGroupBlock.ref,
  ToastBlock.ref,
  SheetBlock.ref,
  SidebarBlock.ref,
  BreadcrumbBlock.ref,
  NavigationMenuBlock.ref,
  MenubarBlock.ref,
  ContextMenuBlock.ref,
  ResizableBlock.ref,
  ScrollAreaBlock.ref,
  AspectRatioBlock.ref,
  MarkerBlock.ref,
  AttachmentBlock.ref,
  BubbleBlock.ref,
  MessageBlock.ref,
  MessageScrollerBlock.ref,
  QuestionnaireBlock.ref,
]);

export const ChatContentChildUnion = z.union([...ContentChildUnion.options, FollowUpBlock.ref]);
