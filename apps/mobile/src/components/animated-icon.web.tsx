import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';
import Animated, { Keyframe } from 'react-native-reanimated';

import classes from './animated-icon.module.css';
const DURATION = 300;
/** The glow spins for four minutes; keyframe offsets are percentages of this. */
const GLOW_DURATION = 4 * 60 * 1000;

export function AnimatedSplashOverlay() {
  return null;
}

// These keyframes declare linear easing on purpose. Reanimated's web keyframe parser
// (layoutReanimation/web/animationParser.ts) resolves a frame's easing only by one of the
// seven WebEasings names (linear, ease, quad, cubic, sin, circle, exp) and treats anything
// else, including Easing.elastic(), as linear; the element's own timing function
// (web/componentUtils.ts) is linear because the Keyframe builder has no .easing() (only the
// preset builders such as FadeIn do). The elastic easings this file used to carry never
// rendered. The native twin (animated-icon.tsx) keeps its elastic easings because the
// native path runs them.
const keyframe = new Keyframe({
  0: {
    transform: [{ scale: 0 }],
  },
  60: {
    transform: [{ scale: 1.2 }],
  },
  100: {
    transform: [{ scale: 1 }],
  },
});

const logoKeyframe = new Keyframe({
  0: {
    opacity: 0,
  },
  60: {
    transform: [{ scale: 1.2 }],
    opacity: 0,
  },
  100: {
    transform: [{ scale: 1 }],
    opacity: 1,
  },
});

const glowKeyframe = new Keyframe({
  0: {
    transform: [{ rotateZ: '-180deg' }, { scale: 0.8 }],
    opacity: 0,
  },
  [(DURATION / GLOW_DURATION) * 100]: {
    transform: [{ rotateZ: '0deg' }, { scale: 1 }],
    opacity: 1,
  },
  100: {
    transform: [{ rotateZ: '7200deg' }, { scale: 1 }],
  },
});

export function AnimatedIcon() {
  return (
    <View style={styles.iconContainer}>
      <Animated.View entering={glowKeyframe.duration(GLOW_DURATION)} style={styles.glow}>
        <Image style={styles.glow} source={require('@/assets/images/logo-glow.png')} />
      </Animated.View>

      <Animated.View style={styles.background} entering={keyframe.duration(DURATION)}>
        <div className={classes.expoLogoBackground} />
      </Animated.View>

      <Animated.View style={styles.imageContainer} entering={logoKeyframe.duration(DURATION)}>
        <Image style={styles.image} source={require('@/assets/images/expo-logo.png')} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    width: '100%',
    zIndex: 1000,
    position: 'absolute',
    top: 128 / 2 + 138,
  },
  imageContainer: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  glow: {
    width: 201,
    height: 201,
    position: 'absolute',
  },
  iconContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 128,
    height: 128,
  },
  image: {
    position: 'absolute',
    width: 76,
    height: 71,
  },
  background: {
    width: 128,
    height: 128,
    position: 'absolute',
  },
});
