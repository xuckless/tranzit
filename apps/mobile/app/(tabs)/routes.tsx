import { View, Text, StyleSheet } from "react-native";
export default function RouteScreen() {
  return (
    <View style={styles.container}>
      <Text>Route Screen</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
