import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  BackHandler,
  Dimensions,
  Keyboard,
} from "react-native";
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedKeyboard,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { DestinationSuggestionsList } from "./DestinationSuggestionsList";
import { useDestinationSearch } from "../../hooks/useDestinationSearch";
import { useRecentSearches } from "../../hooks/useSearchHistory";
import { recentToSuggestion } from "../../lib/searchHistory";
import { TranzitApiService } from "../../services/TranzitApiService";
import type { SelectedDestination, SearchSuggestion } from "../../types/places";
import { useTheme } from "../../contexts/ThemeContext";
import type { AppTheme } from "../../styles/themes";

const { height: SCREEN_HEIGHT } = Dimensions.get("window");
const DURATION = 280;
const EASE = Easing.out(Easing.cubic);
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface UserLocation {
  latitude: number;
  longitude: number;
}

interface Props {
  userLocation?: UserLocation | null;
  /** Window-Y of the resting trigger, so the bar appears to lift from there. */
  restingY: number;
  onDestinationSelected: (dest: SelectedDestination) => void;
  onClose: () => void;
}

/**
 * Full-screen, top-anchored search for the Map. On mount the bar animates up from
 * its resting position over a solid panel (ease-out ~280ms); the suggestions/recents
 * list fills the space above the keyboard. Exits via scrim tap, Android back,
 * swipe-down, and the close (X) button — all reverse the animation.
 */
export const SearchOverlay: React.FC<Props> = ({
  userLocation,
  restingY,
  onDestinationSelected,
  onClose,
}) => {
  const { theme } = useTheme();
  const { colors } = theme;
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const [query, setQuery] = useState("");
  const { status, suggestions, search, reset } =
    useDestinationSearch(userLocation);
  const { recents, refresh } = useRecentSearches();
  const inputRef = useRef<TextInput>(null);

  const topTarget = insets.top + 8;
  const start = (restingY >= 0 ? restingY : SCREEN_HEIGHT * 0.82) - topTarget;

  const progress = useSharedValue(0);
  const drag = useSharedValue(0);
  const keyboard = useAnimatedKeyboard();

  // Enter: animate in, hydrate recents, focus the field.
  useEffect(() => {
    progress.value = withTiming(1, { duration: DURATION, easing: EASE });
    refresh();
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requestClose = useCallback(() => {
    Keyboard.dismiss();
    drag.value = withTiming(0, { duration: DURATION, easing: EASE });
    progress.value = withTiming(
      0,
      { duration: DURATION, easing: EASE },
      (finished) => {
        if (finished) runOnJS(onClose)();
      },
    );
  }, [onClose, drag, progress]);

  // Android hardware back / back gesture.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      requestClose();
      return true;
    });
    return () => sub.remove();
  }, [requestClose]);

  const handleChange = useCallback(
    (text: string) => {
      setQuery(text);
      search(text);
    },
    [search],
  );

  const handleClearText = useCallback(() => {
    setQuery("");
    reset();
  }, [reset]);

  const handleSelect = useCallback(
    async (s: SearchSuggestion) => {
      Keyboard.dismiss();
      let coordinate: { latitude: number; longitude: number };
      if (s.location) {
        coordinate = s.location;
      } else {
        try {
          const details = await TranzitApiService.getPlaceDetails(s.placeId);
          coordinate = details.location;
        } catch (e) {
          console.error("[SearchOverlay] details fetch failed:", e);
          requestClose();
          return;
        }
      }
      onDestinationSelected({
        placeId: s.placeId,
        displayText: s.mainText,
        coordinate,
      });
      requestClose();
    },
    [onDestinationSelected, requestClose],
  );

  // Swipe-down on the bar/handle area dismisses (kept off the list to avoid
  // fighting its scroll).
  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .onUpdate((e) => {
          drag.value = Math.max(0, e.translationY);
        })
        .onEnd((e) => {
          if (e.translationY > 80 || e.velocityY > 600) {
            runOnJS(requestClose)();
          } else {
            drag.value = withTiming(0, { duration: 200, easing: EASE });
          }
        }),
    [drag, requestClose],
  );

  const bgStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const panelStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(progress.value, [0, 1], [start, 0]) + drag.value },
    ],
  }));
  const listStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    paddingBottom: keyboard.height.value,
  }));

  const showRecents = query.trim() === "" && recents.length > 0;
  const recentSuggestions = useMemo(
    () => recents.map(recentToSuggestion),
    [recents],
  );

  return (
    <View style={StyleSheet.absoluteFill}>
      {/* Solid, tappable background (opaque panel + scrim-to-close). */}
      <AnimatedPressable
        style={[StyleSheet.absoluteFill, { backgroundColor: colors.surface }, bgStyle]}
        onPress={requestClose}
        accessibilityLabel="Close search"
      />

      <Animated.View
        style={[styles.panel, { top: topTarget }, panelStyle]}
        pointerEvents="box-none"
      >
        <GestureDetector gesture={panGesture}>
          <View>
            <View style={styles.handleRow}>
              <View style={[styles.handle, { backgroundColor: colors.divider }]} />
            </View>
            <View style={styles.barRow}>
              <View
                style={[
                  styles.bar,
                  { backgroundColor: colors.surface2, borderColor: colors.border },
                ]}
              >
                {status === "loading" ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <Ionicons name="search" size={18} color={colors.ink3} />
                )}
                <TextInput
                  ref={inputRef}
                  style={[styles.input, { color: colors.ink }]}
                  value={query}
                  onChangeText={handleChange}
                  placeholder="Where to?"
                  placeholderTextColor={colors.ink2}
                  returnKeyType="search"
                  autoCorrect={false}
                  autoCapitalize="none"
                />
                {query.length > 0 && (
                  <Pressable
                    onPress={handleClearText}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    accessibilityLabel="Clear search"
                  >
                    <Ionicons name="close-circle" size={18} color={colors.ink2} />
                  </Pressable>
                )}
              </View>
              <Pressable
                onPress={requestClose}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                style={styles.exitBtn}
                accessibilityLabel="Close search"
              >
                <Ionicons name="close" size={22} color={colors.ink3} />
              </Pressable>
            </View>
          </View>
        </GestureDetector>

        <Animated.View style={[styles.listWrap, listStyle]}>
          {showRecents ? (
            <DestinationSuggestionsList
              variant="recent"
              suggestions={recentSuggestions}
              onSelect={handleSelect}
            />
          ) : status === "loading" ? (
            <ActivityIndicator
              style={{ marginTop: 24 }}
              size="small"
              color={colors.primary}
            />
          ) : status === "success" ? (
            <DestinationSuggestionsList
              suggestions={suggestions}
              onSelect={handleSelect}
            />
          ) : status === "empty" ? (
            <Text style={[styles.emptyText, { color: colors.ink3 }]}>
              No results found
            </Text>
          ) : null}
        </Animated.View>
      </Animated.View>
    </View>
  );
};

const makeStyles = (t: AppTheme) => {
  const { colors, typography, radii, spacing } = t;
  return StyleSheet.create({
    panel: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
    },
    handleRow: { alignItems: "center", paddingVertical: 8 },
    handle: { width: 40, height: 4, borderRadius: 2 },
    barRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: spacing.card,
    },
    bar: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.element,
      backgroundColor: colors.surface2,
      borderRadius: radii.chip,
      borderWidth: 0.5,
      borderColor: colors.border,
      paddingHorizontal: 12,
      height: 48,
    },
    input: {
      flex: 1,
      ...typography.buttonLg,
      color: colors.ink,
    },
    exitBtn: { padding: 4, opacity: 0.6 },
    listWrap: {
      flex: 1,
      paddingHorizontal: spacing.card,
      marginTop: spacing.element,
    },
    emptyText: {
      ...typography.mono,
      textAlign: "center",
      paddingVertical: 20,
    },
  });
};
