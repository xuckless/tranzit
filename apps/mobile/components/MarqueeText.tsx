import { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
  type LayoutChangeEvent,
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useFrameCallback,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

interface MarqueeTextProps {
  text: string;
  style?: StyleProp<TextStyle>;
  /** Layout style for the outer clip box, e.g. { flex: 1 }. */
  containerStyle?: StyleProp<ViewStyle>;
  /** Alignment used only while the text fits (no scrolling). */
  align?: "left" | "right";
  /** Scroll speed in px/s. */
  speed?: number;
  /** Gap in px between the repeated copies. */
  gap?: number;
}

/**
 * Single-line text that scrolls horizontally like an LED sign when it overflows
 * its container, and stays static (respecting `align`) when it fits. The user
 * can grab and scrub the scrolling text; auto-scroll resumes on release.
 *
 * Built on the same reanimated + gesture-handler stack as the bottom sheet, so
 * `activeOffsetX` lets a vertical swipe still scroll the sheet underneath.
 */
export function MarqueeText({
  text,
  style,
  containerStyle,
  align = "left",
  speed = 50,
  gap = 36,
}: MarqueeTextProps) {
  const [containerW, setContainerW] = useState(0);
  const [textW, setTextW] = useState(0);

  const overflowing = textW > 0 && containerW > 0 && textW > containerW + 0.5;
  const single = textW + gap;

  const tx = useSharedValue(0);
  const dragging = useSharedValue(false);

  useFrameCallback((frame) => {
    if (!overflowing || single <= 0) return;
    if (!dragging.value) {
      const dt = (frame.timeSincePreviousFrame ?? 16) / 1000;
      tx.value -= speed * dt;
    }
    if (tx.value <= -single) tx.value += single;
    if (tx.value > 0) tx.value -= single;
  });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }],
  }));

  const pan = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .onBegin(() => {
      dragging.value = true;
    })
    .onChange((e) => {
      tx.value += e.changeX;
      if (tx.value <= -single) tx.value += single;
      if (tx.value > 0) tx.value -= single;
    })
    .onFinalize(() => {
      dragging.value = false;
    });

  const onContainerLayout = (e: LayoutChangeEvent) =>
    setContainerW(e.nativeEvent.layout.width);
  const onTextLayout = (e: LayoutChangeEvent) =>
    setTextW(e.nativeEvent.layout.width);

  return (
    <View
      style={[containerStyle, styles.clip]}
      onLayout={onContainerLayout}
    >
      {/* Hidden measurer. The wide wrapper prevents the flex container from
          clamping the text width, so onLayout reports its true intrinsic width. */}
      <View style={styles.measureWrap} pointerEvents="none">
        <Text style={[style, styles.copy]} numberOfLines={1} onLayout={onTextLayout}>
          {text}
        </Text>
      </View>

      {overflowing ? (
        <GestureDetector gesture={pan}>
          <Animated.View style={[styles.row, animatedStyle]}>
            <Text style={[style, styles.copy, { width: textW }]} numberOfLines={1}>
              {text}
            </Text>
            <View style={{ width: gap }} />
            <Text style={[style, styles.copy, { width: textW }]} numberOfLines={1}>
              {text}
            </Text>
          </Animated.View>
        </GestureDetector>
      ) : (
        <Text
          style={[style, styles.static, { textAlign: align }]}
          numberOfLines={1}
        >
          {text}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: "hidden" },
  row: { flexDirection: "row" },
  // Static (fitting) text fills the clip box so `textAlign` is honoured.
  static: { width: "100%" },
  // Inner copies must keep their intrinsic width (never flex-shrink) so the
  // text actually overflows and the marquee has something to scroll.
  copy: { flexShrink: 0, flexGrow: 0, flexBasis: "auto" },
  measureWrap: {
    position: "absolute",
    left: 0,
    top: 0,
    opacity: 0,
    width: 4000,
    flexDirection: "row",
  },
});
