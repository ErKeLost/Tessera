"use client";

import { Checkbox, CheckboxGroup, Label, Radio, RadioGroup, Slider, Switch } from "@heroui/react";
import { defineComponent, reactive, useIsStreaming, useStateField } from "@openuidev/react-lang";
import { z } from "zod";
import { heroSchemas } from "./schemas";
const { CheckBoxGroup: BaseCheckBoxGroup, RadioGroup: BaseRadioGroup, SwitchGroup: BaseSwitchGroup, Slider: BaseSlider } = heroSchemas;

export const HeroCheckBoxGroup = defineComponent({
  ...BaseCheckBoxGroup,
  props: BaseCheckBoxGroup.props.extend({ value: reactive(z.array(z.string()).optional()) }),
  component: ({ props }) => {
    const field = useStateField(props.name, props.value);
    return <CheckboxGroup aria-label={props.name} name={props.name} isDisabled={useIsStreaming()} value={field.value ?? []} onChange={field.setValue}>
      {(props.items ?? []).map((item) => <Checkbox key={item.props.value} value={item.props.value}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>{item.props.label || item.props.value}</Checkbox.Content></Checkbox>)}
    </CheckboxGroup>;
  },
});

export const HeroRadioGroup = defineComponent({
  ...BaseRadioGroup,
  props: BaseRadioGroup.props.extend({ value: reactive(z.string().optional()) }),
  component: ({ props }) => {
    const field = useStateField(props.name, props.value);
    return <RadioGroup aria-label={props.name} name={props.name} isDisabled={useIsStreaming()} value={field.value ?? ""} onChange={field.setValue}>
      {(props.items ?? []).map((item) => <Radio key={item.props.value} value={item.props.value}><Radio.Content><Radio.Control><Radio.Indicator /></Radio.Control>{item.props.label || item.props.value}</Radio.Content></Radio>)}
    </RadioGroup>;
  },
});

export const HeroSwitchGroup = defineComponent({
  ...BaseSwitchGroup,
  props: BaseSwitchGroup.props.extend({ value: reactive(z.array(z.string()).optional()) }),
  component: ({ props }) => {
    const field = useStateField(props.name, props.value);
    const streaming = useIsStreaming();
    const selected = field.value ?? [];
    return <div className="space-y-3">{(props.items ?? []).map((item) => <Switch key={item.props.value} isDisabled={streaming} isSelected={selected.includes(item.props.value)} onChange={(checked) => field.setValue(checked ? [...selected, item.props.value] : selected.filter((value) => value !== item.props.value))}>
      <Switch.Control><Switch.Thumb /></Switch.Control><Switch.Content><Label>{item.props.label || item.props.value}</Label></Switch.Content>
    </Switch>)}</div>;
  },
});

export const HeroSlider = defineComponent({
  ...BaseSlider,
  props: BaseSlider.props.extend({ value: reactive(z.number().optional()) }),
  description: BaseSlider.description + " Optional sixth value argument binds to a $variable.",
  component: ({ props }) => {
    const field = useStateField(props.name, props.value);
    return <Slider aria-label={props.name} isDisabled={useIsStreaming()} minValue={props.min ?? 0} maxValue={props.max ?? 100} step={props.step ?? 1} value={field.value ?? props.defaultValue ?? props.min ?? 0} onChange={(value) => field.setValue(Array.isArray(value) ? value[0] : value)}>
      <Label>{props.name}</Label><Slider.Output /><Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track>
    </Slider>;
  },
});
